/**
 * The native watch-history full replace (and its incremental append) against
 * a real database, driven through the REAL Plex/Jellyfin/Emby clients talking
 * to a local fake server — so each guard is exercised the way it runs in
 * production, paging loops and interceptors included:
 *
 *  - a user whose played-items listing cannot be read completely keeps the
 *    plays already stored for them, instead of failing every sync of the
 *    server (or, when refused, losing them to the replace);
 *  - a transient Plex `/devices` failure no longer blanks the device and
 *    platform of every stored play;
 *  - an empty Plex history page under an unreached total fails the fetch
 *    instead of committing a truncated history;
 *  - a server mapped to Tracearr while the native fetch ran writes nothing;
 *  - an item deleted while the replace was pending, or deleted under it, no
 *    longer rolls the whole replace back.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi, type MockInstance } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import {
  startFakeMediaServer,
  jellyfinRoute,
  type FakeMediaServer,
  type FakePlayedItem,
  type FakeResponse,
  type FakeRoute,
} from "./fake-media-server";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/jobs/client", () => ({
  enqueueJob: vi.fn(async () => true),
  isJobRetrying: vi.fn(async () => false),
}));

import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import { checkWatchHistoryCompleteness } from "@/lib/lifecycle/evaluability";
import { logger } from "@/lib/logger";

const prisma = getTestPrisma();

const SOURCE_CHANGED =
  "the server's watch-history source changed while this sync ran — nothing was written";
const ESTABLISHED = new Date("2025-01-01T00:00:00.000Z");
const T1 = new Date("2025-03-01T10:00:00.000Z");
const T2 = new Date("2025-03-02T10:00:00.000Z");
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);

let fake: FakeMediaServer | null = null;
let txSpy: MockInstance | null = null;

async function serve(route: FakeRoute): Promise<string> {
  fake = await startFakeMediaServer(route);
  return fake.url;
}

const played = (id: string, at = T1): FakePlayedItem => ({
  Id: id,
  UserData: { PlayCount: 1, LastPlayedDate: at.toISOString() },
});

/** A Plex route over `/accounts`, `/devices` and the history listing. */
function plexRoute(options: {
  history: (query: URLSearchParams) => FakeResponse | Promise<FakeResponse>;
  devices?: () => FakeResponse;
}): FakeRoute {
  return (path, query) => {
    if (path === "/accounts") {
      return {
        body: { MediaContainer: { Account: [{ id: 1, name: "alice" }, { id: 2, name: "bob" }] } },
      };
    }
    if (path === "/devices") {
      return options.devices?.() ?? { body: { MediaContainer: { Device: [] } } };
    }
    if (path === "/status/sessions/history/all") return options.history(query);
    return { status: 404, body: { error: `no route for ${path}` } };
  };
}

/** One Plex history page holding every entry, with its total. */
const plexHistory = (entries: Array<Record<string, unknown>>): FakeResponse => ({
  body: { MediaContainer: { totalSize: entries.length, size: entries.length, Metadata: entries } },
});

const plexPlay = (ratingKey: string, accountID: number, at: Date, extra: Record<string, unknown> = {}) => ({
  historyKey: `/status/sessions/history/${ratingKey}-${accountID}-${epoch(at)}`,
  ratingKey,
  accountID,
  viewedAt: epoch(at),
  ...extra,
});

/** The real `$transaction`, captured before any spy replaces it. */
const realTransaction = prisma.$transaction.bind(prisma) as unknown as (
  fn: (tx: unknown) => Promise<unknown>,
  options?: unknown,
) => Promise<unknown>;

/**
 * Wrap every following interactive transaction so `hooks[n]` (for the n-th
 * one) runs at the chosen point: `before` the transaction starts, or just
 * before its first WatchHistory INSERT — i.e. after the in-transaction checks
 * already passed.
 */
function interceptTransactions(
  hooks: Array<{ before?: () => Promise<void>; beforeFirstInsert?: () => Promise<void> } | undefined>,
) {
  let attempt = 0;
  txSpy = vi.spyOn(prisma, "$transaction").mockImplementation((async (
    fn: (tx: unknown) => Promise<unknown>,
    options?: unknown,
  ) => {
    const hook = hooks[attempt++];
    await hook?.before?.();
    return realTransaction(async (tx) => {
      if (!hook?.beforeFirstInsert) return fn(tx);
      let fired = false;
      const wrapped = new Proxy(tx as object, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop === "$executeRawUnsafe") {
            return async (sql: string, ...params: unknown[]) => {
              if (!fired && sql.includes('INSERT INTO "WatchHistory"')) {
                fired = true;
                await hook.beforeFirstInsert!();
              }
              return (value as (...args: unknown[]) => unknown).call(target, sql, ...params);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return fn(wrapped);
    }, options);
  }) as never);
  return txSpy;
}

describe("native watch-history writes", () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDatabase();
    vi.mocked(logger.warn).mockClear();
    const user = await createTestUser();
    userId = user.id;
  });

  afterEach(async () => {
    txSpy?.mockRestore();
    txSpy = null;
    await fake?.close();
    fake = null;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const rowsOf = (serverId: string) =>
    prisma.watchHistory.findMany({
      where: { mediaServerId: serverId },
      orderBy: [{ serverUsername: "asc" }, { watchedAt: "asc" }],
      select: {
        mediaItemId: true,
        serverUsername: true,
        watchedAt: true,
        deviceName: true,
        platform: true,
        source: true,
      },
    });
  const markerOf = async (serverId: string) =>
    (await prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } })).watchHistorySyncedAt;
  const store = (data: {
    mediaItemId: string;
    mediaServerId: string;
    serverUsername: string;
    watchedAt: Date;
    deviceName?: string;
    platform?: string;
  }) => prisma.watchHistory.create({ data });

  describe("a Jellyfin/Emby user whose listing cannot be read completely", () => {
    /** Movies m-x, m-y, m-z, m-w; alice played m-x and bob m-y at the last sync. */
    async function fixture(type: "JELLYFIN" | "EMBY", route: Parameters<typeof jellyfinRoute>[0]) {
      const url = await serve(jellyfinRoute(route));
      const server = await createTestServer(userId, { type, url, watchHistorySyncedAt: ESTABLISHED });
      const library = await createTestLibrary(server.id, { key: "movies" });
      const item = (ratingKey: string) => createTestMediaItem(library.id, { ratingKey, title: ratingKey });
      const [x, y, z, w] = [await item("m-x"), await item("m-y"), await item("m-z"), await item("m-w")];
      await store({ mediaItemId: x.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: T1 });
      await store({ mediaItemId: y.id, mediaServerId: server.id, serverUsername: "bob", watchedAt: T1 });
      return { server, x, y, z, w };
    }
    /** An empty first page under a non-zero total: bob's items are all hidden from the key. */
    const hiddenItems = () => ({ body: { Items: [], TotalRecordCount: 5 } });

    it.each(["JELLYFIN", "EMBY"] as const)(
      "%s: keeps that user's stored plays and replaces everyone else's",
      async (type) => {
        const { server, y, z } = await fixture(type, { alice: [played("m-z", T2)], bob: hiddenItems });

        // Before: every sync of this server failed, for as long as bob's items
        // stayed hidden.
        await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

        expect(await rowsOf(server.id)).toEqual([
          // alice's history replaced: m-x is gone, m-z is new.
          expect.objectContaining({ mediaItemId: z.id, serverUsername: "alice", watchedAt: T2 }),
          // bob's stands.
          expect.objectContaining({ mediaItemId: y.id, serverUsername: "bob", watchedAt: T1 }),
        ]);
        expect(logger.warn).toHaveBeenCalledWith(
          "WatchHistory",
          expect.stringContaining('Not replacing the stored plays of "bob" (listing incomplete)'),
        );
        // Still established: bob's rows stand, so nothing became vacuous.
        expect((await markerOf(server.id))!.getTime()).toBeGreaterThan(ESTABLISHED.getTime());
        expect(await checkWatchHistoryCompleteness(userId, [server.id])).toEqual({ complete: true });
      },
    );

    describe("whether a sync that set a user aside may vouch for the history", () => {
      // The marker says the stored history is a faithful record. A set-aside
      // user's stored rows stand in for their plays as their last reliable
      // record; but a user with NO stored rows on a server whose marker was
      // null (a first sync, or a history wiped by a source switch or a
      // config-only restore) has nothing to stand in, and an unreliable
      // listing says by its own count that they have plays this run missed.
      async function server(options: {
        marker: Date | null;
        route: Parameters<typeof jellyfinRoute>[0];
        storedForBob?: boolean;
      }) {
        const url = await serve(jellyfinRoute(options.route));
        const srv = await createTestServer(userId, { type: "JELLYFIN", url, watchHistorySyncedAt: options.marker });
        const library = await createTestLibrary(srv.id, { key: "movies" });
        const a = await createTestMediaItem(library.id, { ratingKey: "m-a" });
        // Watched only by bob, per the server.
        const b = await createTestMediaItem(library.id, { ratingKey: "m-b" });
        if (options.storedForBob) {
          await store({ mediaItemId: b.id, mediaServerId: srv.id, serverUsername: "bob", watchedAt: T1 });
        }
        return { server: srv, a, b };
      }
      const expectPaused = async (serverId: string) =>
        expect(await checkWatchHistoryCompleteness(userId, [serverId])).toMatchObject({ complete: false });

      it("does not establish a history that was never established, with an unreliable user set aside", async () => {
        // The reviewer's H1: before, the sync stored only alice, marked the
        // history established, and every item only bob watched read as never
        // played — `playCount = 0` and negative `watchedByUser` rules armed.
        const { server: srv, a } = await server({
          marker: null,
          route: { alice: [played("m-a")], bob: hiddenItems },
        });

        // The readable users' rows are still committed.
        await expect(syncWatchHistory(srv.id)).resolves.toEqual({ count: 1 });

        expect(await rowsOf(srv.id)).toEqual([
          expect.objectContaining({ mediaItemId: a.id, serverUsername: "alice" }),
        ]);
        expect(await markerOf(srv.id)).toBeNull();
        await expectPaused(srv.id);
        // Naming the user and what lifts it — a Refresh does not.
        expect(logger.warn).toHaveBeenCalledWith(
          "WatchHistory",
          expect.stringMatching(
            /Not marking .*established.*"bob".*stay paused\. Make their played items readable in Jellyfin \(their library access, parental controls\) or remove the user there — a Refresh alone does not lift this/,
          ),
        );
        // And indeed a Refresh does not lift it while bob stays unreadable.
        await expect(syncWatchHistory(srv.id)).resolves.toEqual({ count: 1 });
        expect(await markerOf(srv.id)).toBeNull();
      });

      it("does not establish it on the empty-history path either", async () => {
        const { server: srv } = await server({ marker: null, route: { alice: [], bob: hiddenItems } });

        await expect(syncWatchHistory(srv.id)).resolves.toEqual({ count: 0 });

        expect(await markerOf(srv.id)).toBeNull();
        await expectPaused(srv.id);
      });

      it("establishes a history whose marker was null when bob's stored rows survive — they stand as his last record", async () => {
        // Every release of a library-resync hold (a purge, a vanished library,
        // a library's first sync, a restore) nulls the marker on purpose.
        // Refusing whenever bob was set aside then kept a server with one
        // persistently unreliable user paused for good.
        const { server: srv, b } = await server({
          marker: null,
          route: { alice: [played("m-a")], bob: hiddenItems },
          storedForBob: true,
        });

        await expect(syncWatchHistory(srv.id)).resolves.toEqual({ count: 1 });

        expect((await rowsOf(srv.id)).filter((r) => r.serverUsername === "bob")).toEqual([
          expect.objectContaining({ mediaItemId: b.id }),
        ]);
        expect(await markerOf(srv.id)).not.toBeNull();
        expect(await checkWatchHistoryCompleteness(userId, [srv.id])).toEqual({ complete: true });
      });

      it("counts only the server's own rows: bob's plays on ANOTHER server do not stand in", async () => {
        const { server: srv } = await server({
          marker: null,
          route: { alice: [played("m-a")], bob: hiddenItems },
        });
        const other = await createTestServer(userId, { type: "JELLYFIN", name: "Other" });
        const otherLib = await createTestLibrary(other.id, { key: "x" });
        const otherItem = await createTestMediaItem(otherLib.id, { ratingKey: "o-1" });
        await store({ mediaItemId: otherItem.id, mediaServerId: other.id, serverUsername: "bob", watchedAt: T1 });

        await expect(syncWatchHistory(srv.id)).resolves.toEqual({ count: 1 });

        expect(await markerOf(srv.id)).toBeNull();
      });

      it("re-establishes an established history, with the unreliable user's rows standing", async () => {
        const { server: srv, b } = await server({
          marker: ESTABLISHED,
          route: { alice: [played("m-a")], bob: hiddenItems },
          storedForBob: true,
        });

        await expect(syncWatchHistory(srv.id)).resolves.toEqual({ count: 1 });

        expect((await rowsOf(srv.id)).filter((r) => r.serverUsername === "bob")).toEqual([
          expect.objectContaining({ mediaItemId: b.id }),
        ]);
        expect((await markerOf(srv.id))!.getTime()).toBeGreaterThan(ESTABLISHED.getTime());
        expect(await checkWatchHistoryCompleteness(userId, [srv.id])).toEqual({ complete: true });
      });

      it("establishes a fresh server with only a REFUSED user set aside, as it always did", async () => {
        // The key cannot read bob and never will: waiting for him would block
        // a fresh server for good.
        const { server: srv } = await server({
          marker: null,
          route: { alice: [played("m-a")], bob: () => ({ status: 403, body: { error: "forbidden" } }) },
        });

        await expect(syncWatchHistory(srv.id)).resolves.toEqual({ count: 1 });

        expect(await markerOf(srv.id)).not.toBeNull();
        expect(await checkWatchHistoryCompleteness(userId, [srv.id])).toEqual({ complete: true });
      });

      it("fails the fetch on a proxy that ignores StartIndex, rather than setting aside every multi-page user", async () => {
        // The reviewer's H1b: bob (1,000+ plays) was set aside, alice had none,
        // and an EMPTY history was established — `playCount = 0` then matched
        // the whole library.
        const firstPage = Array.from({ length: 1000 }, (_, i) => played(`m-${i}`));
        const { server: srv } = await server({
          marker: null,
          route: { alice: [], bob: () => ({ body: { Items: firstPage, TotalRecordCount: 1500 } }) },
        });

        await expect(syncWatchHistory(srv.id)).resolves.toEqual({
          count: 0,
          failed: expect.stringContaining("ignored StartIndex"),
        });

        expect(await prisma.watchHistory.count({ where: { mediaServerId: srv.id } })).toBe(0);
        expect(await markerOf(srv.id)).toBeNull();
        await expectPaused(srv.id);
      });

      it("leaves an established history untouched when the proxy ignores StartIndex", async () => {
        const firstPage = Array.from({ length: 1000 }, (_, i) => played(`m-${i}`));
        const { server: srv } = await server({
          marker: ESTABLISHED,
          route: { alice: [played("m-a")], bob: () => ({ body: { Items: firstPage, TotalRecordCount: 1500 } }) },
          storedForBob: true,
        });
        const before = await rowsOf(srv.id);

        await expect(syncWatchHistory(srv.id)).resolves.toEqual({
          count: 0,
          failed: expect.stringContaining("ignored StartIndex"),
        });

        expect(await rowsOf(srv.id)).toEqual(before);
        expect(await markerOf(srv.id)).toEqual(ESTABLISHED);
      });
    });

    it("stores none of the pages that user's listing delivered before it proved incomplete", async () => {
      const { server, y, w } = await fixture("JELLYFIN", {
        alice: [played("m-z", T2)],
        // A first page of one, then nothing, under a total of 1,000.
        bob: (startIndex) => ({
          body: { Items: startIndex === 0 ? [played("m-w", T2)] : [], TotalRecordCount: 1000 },
        }),
      });

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

      const bobs = (await rowsOf(server.id)).filter((r) => r.serverUsername === "bob");
      expect(bobs).toEqual([expect.objectContaining({ mediaItemId: y.id, watchedAt: T1 })]);
      expect(bobs.some((r) => r.mediaItemId === w.id)).toBe(false);
    });

    it("keeps the stored plays of a user the key is refused for", async () => {
      // A refused user used to be skipped — and the replace then deleted every
      // play they had, so the items they watched read as never watched.
      const { server, y } = await fixture("JELLYFIN", {
        alice: [played("m-z", T2)],
        bob: () => ({ status: 403, body: { error: "forbidden" } }),
      });

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

      expect((await rowsOf(server.id)).filter((r) => r.serverUsername === "bob")).toEqual([
        expect.objectContaining({ mediaItemId: y.id }),
      ]);
    });

    it("keeps that user's plays when everyone else reports none (the empty-history path)", async () => {
      const { server, y } = await fixture("JELLYFIN", { alice: [], bob: hiddenItems });

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 0 });

      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ mediaItemId: y.id, serverUsername: "bob" }),
      ]);
      expect((await markerOf(server.id))!.getTime()).toBeGreaterThan(ESTABLISHED.getTime());
    });

    it("still fails the sync, touching nothing, when no user could be read", async () => {
      const { server } = await fixture("JELLYFIN", {
        alice: hiddenItems,
        bob: () => ({ status: 403, body: { error: "forbidden" } }),
      });
      const before = await rowsOf(server.id);

      const result = await syncWatchHistory(server.id);

      expect(result).toEqual({ count: 0, failed: expect.stringMatching(/fetch failed.*all 2 user/) });
      expect(await rowsOf(server.id)).toEqual(before);
      expect(await markerOf(server.id)).toEqual(ESTABLISHED);
    });

    it("still fails the sync on a transient failure, touching nothing", async () => {
      const { server } = await fixture("JELLYFIN", {
        alice: [played("m-z", T2)],
        // Not retried and not a user-level condition: a malformed page.
        bob: () => ({ body: { TotalRecordCount: 5 } }),
      });
      const before = await rowsOf(server.id);

      await expect(syncWatchHistory(server.id)).resolves.toEqual({
        count: 0,
        failed: expect.stringContaining("no Items list"),
      });
      expect(await rowsOf(server.id)).toEqual(before);
    });
  });

  describe("Plex device names when /devices fails", () => {
    async function fixture(devices: () => FakeResponse) {
      const url = await serve(
        plexRoute({
          devices,
          history: () =>
            plexHistory([
              plexPlay("200", 1, T2, { deviceID: 7 }),
              plexPlay("100", 1, T1, { deviceID: 7 }),
            ]),
        }),
      );
      const server = await createTestServer(userId, { type: "PLEX", url, watchHistorySyncedAt: ESTABLISHED });
      const library = await createTestLibrary(server.id, { key: "1" });
      const known = await createTestMediaItem(library.id, { ratingKey: "100" });
      const fresh = await createTestMediaItem(library.id, { ratingKey: "200" });
      // Stored at the last sync: alice's play of 100 at T1, on the Roku.
      await store({
        mediaItemId: known.id,
        mediaServerId: server.id,
        serverUsername: "alice",
        watchedAt: T1,
        deviceName: "Roku",
        platform: "Roku OS",
      });
      return { server, known, fresh };
    }

    it.each([
      ["answers with an error", () => ({ status: 403, body: { error: "forbidden" } })],
      ["answers with a page that is not a device list", () => ({ body: "<html>Sign in</html>" })],
    ])("keeps the stored device of every re-delivered play when /devices %s", async (_label, devices) => {
      const { server, known, fresh } = await fixture(devices as () => FakeResponse);

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 2 });

      const rows = await rowsOf(server.id);
      expect(rows).toEqual([
        expect.objectContaining({ mediaItemId: known.id, watchedAt: T1, deviceName: "Roku", platform: "Roku OS" }),
        // A new play has nothing stored to keep.
        expect.objectContaining({ mediaItemId: fresh.id, watchedAt: T2, deviceName: null, platform: null }),
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("did not answer its device list"),
      );
    });

    it("replaces the stored device when /devices answers, and never carries a stale one over", async () => {
      // Device 7 is now the Shield; and 100's play is re-delivered with a
      // device the list does not name, which must not inherit the Roku.
      const url = await serve(
        plexRoute({
          devices: () => ({ body: { MediaContainer: { Device: [{ id: 7, name: "Shield", platform: "Android" }] } } }),
          history: () =>
            plexHistory([
              plexPlay("200", 1, T2, { deviceID: 7 }),
              plexPlay("100", 1, T1, { deviceID: 99 }),
            ]),
        }),
      );
      const server = await createTestServer(userId, { type: "PLEX", url });
      const library = await createTestLibrary(server.id, { key: "1" });
      const known = await createTestMediaItem(library.id, { ratingKey: "100" });
      const fresh = await createTestMediaItem(library.id, { ratingKey: "200" });
      await store({
        mediaItemId: known.id,
        mediaServerId: server.id,
        serverUsername: "alice",
        watchedAt: T1,
        deviceName: "Roku",
        platform: "Roku OS",
      });

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 2 });

      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ mediaItemId: known.id, deviceName: null, platform: null }),
        expect.objectContaining({ mediaItemId: fresh.id, deviceName: "Shield", platform: "Android" }),
      ]);
    });

    it("matches a stored device by account too: another account's play at the same second keeps nothing", async () => {
      const url = await serve(
        plexRoute({
          devices: () => ({ status: 403, body: {} }),
          // bob's play of 100 at T1 — the stored Roku row is alice's.
          history: () => plexHistory([plexPlay("100", 2, T1, { deviceID: 7 })]),
        }),
      );
      const server = await createTestServer(userId, { type: "PLEX", url });
      const library = await createTestLibrary(server.id, { key: "1" });
      const known = await createTestMediaItem(library.id, { ratingKey: "100" });
      await store({
        mediaItemId: known.id,
        mediaServerId: server.id,
        serverUsername: "alice",
        watchedAt: T1,
        deviceName: "Roku",
        platform: "Roku OS",
      });

      await syncWatchHistory(server.id);

      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ serverUsername: "bob", deviceName: null, platform: null }),
      ]);
    });
  });

  describe("the realtime refresh while a library-resync hold is set", () => {
    // A purge, restore or disable-with-delete holds the marker null until a
    // complete library sync. The incremental refresh required the marker, so
    // every finished playback ran the full replace instead — the whole history
    // re-fetched and rewritten (≈45 s at 141k plays, on the serial queue) —
    // and, with the marker refused, the next playback did it all again.
    async function plexServer(options: { marker: Date | null; held: boolean; stored: boolean }) {
      const url = await serve(
        plexRoute({ history: async () => plexHistory([plexPlay("100", 2, T2), plexPlay("100", 1, T1)]) }),
      );
      const server = await createTestServer(userId, { type: "PLEX", url, watchHistorySyncedAt: options.marker });
      if (options.held) {
        await prisma.mediaServer.update({
          where: { id: server.id },
          data: { libraryResyncRequiredAt: new Date() },
        });
      }
      const library = await createTestLibrary(server.id, { key: "1" });
      const item = await createTestMediaItem(library.id, { ratingKey: "100" });
      if (options.stored) {
        await store({ mediaItemId: item.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: T1 });
      }
      return { server, item };
    }
    const refresh = (serverId: string) =>
      syncWatchHistory(serverId, undefined, undefined, { incremental: true });
    // Decoded: the client writes `viewedAt>=` into the path, and axios' Node
    // adapter sends the `>` percent-encoded (WHATWG URL parsing).
    const historyRequests = () =>
      fake!.urls
        .filter((url) => url.startsWith("/status/sessions/history/all"))
        .map((url) => decodeURIComponent(url));
    /** The `viewedAt>=` fetch, from an hour before the newest stored play. */
    const expectAppendFetch = () =>
      expect(historyRequests()).toEqual([
        expect.stringContaining(`viewedAt>=${epoch(T1) - 3600}`),
      ]);
    const expectFullFetch = () => {
      expect(historyRequests()).toHaveLength(1);
      expect(historyRequests()[0]).not.toContain("viewedAt>=");
    };
    const notMarkingLines = () =>
      vi.mocked(logger.info).mock.calls.filter((call) => String(call[1]).includes("Not marking"));

    it("appends while held, when there are rows to resume from, and leaves the marker null", async () => {
      const { server, item } = await plexServer({ marker: null, held: true, stored: true });
      vi.mocked(logger.info).mockClear();

      // bob's play is new; alice's is the stored one, re-delivered.
      await expect(refresh(server.id)).resolves.toEqual({ count: 1 });

      expectAppendFetch();
      // An append deletes nothing.
      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ mediaItemId: item.id, serverUsername: "alice", watchedAt: T1 }),
        expect.objectContaining({ mediaItemId: item.id, serverUsername: "bob", watchedAt: T2 }),
      ]);
      // Still held: the releasing full sync establishes it.
      expect(await markerOf(server.id)).toBeNull();
      // And no "not marking" line at info level per finished playback.
      expect(notMarkingLines()).toEqual([]);
    });

    it("runs the full replace while held when there is nothing to resume from", async () => {
      const { server } = await plexServer({ marker: null, held: true, stored: false });

      await expect(refresh(server.id)).resolves.toEqual({ count: 2 });

      expectFullFetch();
      expect(await markerOf(server.id)).toBeNull();
    });

    it("runs the full replace once the hold is released (marker and hold both null)", async () => {
      const { server } = await plexServer({ marker: null, held: false, stored: true });

      await expect(refresh(server.id)).resolves.toEqual({ count: 2 });

      expectFullFetch();
      expect(await markerOf(server.id)).not.toBeNull();
    });

    it("appends on an established server, as before", async () => {
      const { server } = await plexServer({ marker: ESTABLISHED, held: false, stored: true });

      await expect(refresh(server.id)).resolves.toEqual({ count: 1 });

      expectAppendFetch();
      expect((await markerOf(server.id))!.getTime()).toBeGreaterThan(ESTABLISHED.getTime());
    });
  });

  describe("why the history was not marked established", () => {
    // The compare-and-set refuses for two reasons with different remedies; the
    // log line used to blame a withdrawal for both.
    async function plexServer(marker: Date | null, history?: () => Promise<FakeResponse>) {
      const url = await serve(
        plexRoute({ history: history ?? (async () => plexHistory([plexPlay("100", 1, T1)])) }),
      );
      const server = await createTestServer(userId, { type: "PLEX", url, watchHistorySyncedAt: marker });
      const library = await createTestLibrary(server.id, { key: "1" });
      await createTestMediaItem(library.id, { ratingKey: "100" });
      return server;
    }
    const infoLines = () => vi.mocked(logger.info).mock.calls.map((call) => String(call[1]));

    it("names the library-resync hold, which only a complete library sync settles", async () => {
      const server = await plexServer(null);
      await prisma.mediaServer.update({
        where: { id: server.id },
        data: { libraryResyncRequiredAt: new Date() },
      });
      vi.mocked(logger.info).mockClear();

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

      expect(await markerOf(server.id)).toBeNull();
      expect(infoLines().some((line) => line.includes("complete library sync"))).toBe(true);
      expect(infoLines().some((line) => line.includes("withdrawn or re-established"))).toBe(false);
    });

    it("names a withdrawal while the sync ran, which the next sync settles", async () => {
      let serverId = "";
      const server = await plexServer(ESTABLISHED, async () => {
        // A purge's withdrawal, landing mid-fetch.
        await prisma.mediaServer.update({ where: { id: serverId }, data: { watchHistorySyncedAt: null } });
        return plexHistory([plexPlay("100", 1, T1)]);
      });
      serverId = server.id;
      vi.mocked(logger.info).mockClear();

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

      expect(await markerOf(server.id)).toBeNull();
      expect(infoLines().some((line) => line.includes("withdrawn or re-established"))).toBe(true);
      expect(infoLines().some((line) => line.includes("complete library sync"))).toBe(false);
    });
  });

  describe("a Plex history listing that ends short of its reported total", () => {
    it("fails the sync instead of committing the truncated history", async () => {
      // `{ totalSize: 141000, size: 0 }` used to end the walk with nothing, and
      // the full replace deleted every stored play and marked it established.
      const url = await serve(
        plexRoute({ history: () => ({ body: { MediaContainer: { totalSize: 141000, size: 0 } } }) }),
      );
      const server = await createTestServer(userId, { type: "PLEX", url, watchHistorySyncedAt: ESTABLISHED });
      const library = await createTestLibrary(server.id, { key: "1" });
      const item = await createTestMediaItem(library.id, { ratingKey: "100" });
      await store({ mediaItemId: item.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: T1 });

      await expect(syncWatchHistory(server.id)).resolves.toEqual({
        count: 0,
        failed: expect.stringContaining("ended at 0 of a reported 141000"),
      });
      expect(await rowsOf(server.id)).toHaveLength(1);
      expect(await markerOf(server.id)).toEqual(ESTABLISHED);
    });
  });

  describe("a server mapped to Tracearr while the native fetch ran", () => {
    /**
     * What the server PUT (wipe + mapping, under the same advisory lock) and a
     * backfill slice (its first TRACEARR row) do while this sync is fetching.
     * The marker is left alone so the test sees whether the sync writes it.
     */
    async function mapToTracearr(serverId: string, itemId: string) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtext('watch-history:' || $1))`,
          serverId,
        );
        await tx.mediaServer.update({ where: { id: serverId }, data: { tracearrServerId: "tracearr-srv-1" } });
        await tx.watchHistory.deleteMany({ where: { mediaServerId: serverId } });
      });
      await prisma.watchHistory.create({
        data: {
          mediaItemId: itemId,
          mediaServerId: serverId,
          serverUsername: "alice",
          watchedAt: T2,
          source: "TRACEARR",
          sourceEventId: "chain-1",
        },
      });
    }

    async function fixture(history: (ids: { serverId: string; itemId: string }) => Promise<FakeResponse>) {
      const ids = { serverId: "", itemId: "" };
      const url = await serve(plexRoute({ history: () => history(ids) }));
      const server = await createTestServer(userId, { type: "PLEX", url, watchHistorySyncedAt: ESTABLISHED });
      const library = await createTestLibrary(server.id, { key: "1" });
      const item = await createTestMediaItem(library.id, { ratingKey: "100" });
      await store({ mediaItemId: item.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: T1 });
      ids.serverId = server.id;
      ids.itemId = item.id;
      return { server, item };
    }

    async function expectTracearrRowsOnly(serverId: string) {
      expect(await rowsOf(serverId)).toEqual([
        expect.objectContaining({ source: "TRACEARR", watchedAt: T2 }),
      ]);
      // Not re-established over the importer's history.
      expect(await markerOf(serverId)).toEqual(ESTABLISHED);
    }

    it("full replace: writes nothing, and reports the change", async () => {
      const { server } = await fixture(async (ids) => {
        await mapToTracearr(ids.serverId, ids.itemId);
        return plexHistory([plexPlay("100", 1, T1)]);
      });

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 0, failed: SOURCE_CHANGED });

      await expectTracearrRowsOnly(server.id);
    });

    it("empty history: writes nothing, and reports the change", async () => {
      const { server } = await fixture(async (ids) => {
        await mapToTracearr(ids.serverId, ids.itemId);
        return plexHistory([]);
      });

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 0, failed: SOURCE_CHANGED });

      await expectTracearrRowsOnly(server.id);
    });

    it("incremental append: writes nothing, and reports the change", async () => {
      const { server } = await fixture(async (ids) => {
        await mapToTracearr(ids.serverId, ids.itemId);
        return plexHistory([plexPlay("100", 2, new Date(T1.getTime() + 60_000))]);
      });

      await expect(
        syncWatchHistory(server.id, undefined, undefined, { incremental: true }),
      ).resolves.toEqual({ count: 0, failed: SOURCE_CHANGED });

      // The append ran (a `viewedAt>=` fetch), then refused.
      expect(fake!.requests).toContain("/status/sessions/history/all");
      await expectTracearrRowsOnly(server.id);
    });

    it("a server deleted mid-fetch: writes nothing, and reports it rather than throwing", async () => {
      const { server } = await fixture(async (ids) => {
        await prisma.mediaServer.delete({ where: { id: ids.serverId } });
        return plexHistory([plexPlay("100", 1, T1)]);
      });

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 0, failed: SOURCE_CHANGED });
      expect(await prisma.watchHistory.count()).toBe(0);
    });

    it("a server still native is written as usual", async () => {
      const { server, item } = await fixture(async () => plexHistory([plexPlay("100", 2, T2)]));

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ mediaItemId: item.id, serverUsername: "bob", source: "NATIVE" }),
      ]);
    });
  });

  describe("an item deleted while the full replace is pending or running", () => {
    /**
     * Plex server with items 100 and 200 (and 300 when asked); the history
     * holds alice's play of each.
     */
    async function fixture(options: { withThird?: boolean } = {}) {
      const url = await serve(
        plexRoute({
          history: () =>
            plexHistory([
              ...(options.withThird ? [plexPlay("300", 1, T2)] : []),
              plexPlay("200", 1, T2),
              plexPlay("100", 1, T1),
            ]),
        }),
      );
      const server = await createTestServer(userId, { type: "PLEX", url });
      const library = await createTestLibrary(server.id, { key: "1" });
      const kept = await createTestMediaItem(library.id, { ratingKey: "100" });
      const victim = await createTestMediaItem(library.id, { ratingKey: "200" });
      const third = options.withThird
        ? await createTestMediaItem(library.id, { ratingKey: "300" })
        : null;
      return { server, kept, victim, third };
    }

    it("drops the plays of an item deleted after the item map was read, and commits the rest in one go", async () => {
      // Reachable: a History-page Refresh runs outside the serial job queue, so
      // an incremental removal or a purge can land between the map and the
      // write (the write's lock can wait minutes behind another Refresh).
      const { server, kept, victim } = await fixture();
      // The victim held a stored play too; its delete cascades that away.
      await store({ mediaItemId: victim.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: T1 });
      const spy = interceptTransactions([
        { before: async () => void (await prisma.mediaItem.delete({ where: { id: victim.id } })) },
      ]);

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

      expect(await rowsOf(server.id)).toEqual([expect.objectContaining({ mediaItemId: kept.id })]);
      // Narrowed in the first transaction — not rescued by the retry.
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("re-picks the primary copy when the copy that would have held it was deleted", async () => {
      const url = await serve(jellyfinRoute({ alice: [played("jf-1", T1)] }));
      const server = await createTestServer(userId, { type: "JELLYFIN", url });
      const libA = await createTestLibrary(server.id, { key: "lib-a" });
      const libB = await createTestLibrary(server.id, { key: "lib-b" });
      const a = await createTestMediaItem(libA.id, { ratingKey: "jf-1" });
      const b = await createTestMediaItem(libB.id, { ratingKey: "jf-1" });
      const [primary, survivor] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
      const spy = interceptTransactions([
        { before: async () => void (await prisma.mediaItem.delete({ where: { id: primary.id } })) },
      ]);

      // Pointed at the deleted copy, the row would fail its foreign key.
      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

      expect(
        await prisma.watchHistory.findMany({
          where: { mediaServerId: server.id },
          select: { mediaItemId: true, fanOutOfItemId: true },
        }),
      ).toEqual([{ mediaItemId: survivor.id, fanOutOfItemId: null }]);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("retries once when an item is deleted under the write (a real foreign-key violation)", async () => {
      // The victim goes after the in-transaction check passed: its INSERT
      // violates the foreign key, which used to roll back the whole replace.
      const { server, kept, victim } = await fixture();
      await store({ mediaItemId: kept.id, mediaServerId: server.id, serverUsername: "bob", watchedAt: T1 });
      const spy = interceptTransactions([
        { beforeFirstInsert: async () => void (await prisma.mediaItem.delete({ where: { id: victim.id } })) },
      ]);

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

      expect(spy).toHaveBeenCalledTimes(2);
      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ mediaItemId: kept.id, serverUsername: "alice", watchedAt: T1 }),
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("SQLSTATE 23503"),
      );
    });

    it("lets a second failure propagate, with the stored history rolled back to what it was", async () => {
      const { server, kept, victim, third } = await fixture({ withThird: true });
      await store({ mediaItemId: kept.id, mediaServerId: server.id, serverUsername: "bob", watchedAt: T1 });
      const before = await rowsOf(server.id);
      // A different item goes under each attempt's write.
      const spy = interceptTransactions([
        { beforeFirstInsert: async () => void (await prisma.mediaItem.delete({ where: { id: victim.id } })) },
        { beforeFirstInsert: async () => void (await prisma.mediaItem.delete({ where: { id: third!.id } })) },
      ]);

      await expect(syncWatchHistory(server.id)).rejects.toMatchObject({
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "23503" } } },
      });

      // Exactly one retry, and nothing of either attempt kept.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(await rowsOf(server.id)).toEqual(before);
    });

    it("retries once after losing a real deadlock to a concurrent writer", async () => {
      // The replace deletes this server's rows, then its INSERT references an
      // item; a purge locks items, then cascades into the same rows. Here a
      // second transaction locks item 100 and — once the replace is waiting
      // on it — deletes a row the replace already holds. The replace waited
      // first, so it is the one Postgres aborts (SQLSTATE 40P01).
      const { server, kept, victim } = await fixture();
      await prisma.mediaItem.delete({ where: { id: victim.id } });
      const stored = await store({
        mediaItemId: kept.id,
        mediaServerId: server.id,
        serverUsername: "bob",
        watchedAt: T1,
      });
      // Postgres checks a waiter for a deadlock once, when its
      // `deadlock_timeout` expires. The replace starts waiting first, so it
      // checks first — and finds the cycle as long as the other transaction
      // has joined it by then. Joining at a third of the timeout leaves a
      // margin either way, whatever the server is configured with.
      const [{ ms }] = await prisma.$queryRawUnsafe<{ ms: number }[]>(
        `SELECT setting::int AS ms FROM pg_settings WHERE name = 'deadlock_timeout'`,
      );
      let other: Promise<unknown> | undefined;
      const spy = interceptTransactions([
        {
          beforeFirstInsert: async () => {
            let locked!: () => void;
            const lockedItem = new Promise<void>((resolve) => (locked = resolve));
            other = realTransaction(async (tx) => {
              const t = tx as typeof prisma;
              await t.$executeRawUnsafe(`SELECT 1 FROM "MediaItem" WHERE "id" = $1 FOR UPDATE`, kept.id);
              locked();
              await new Promise((resolve) => setTimeout(resolve, Math.floor(ms / 3)));
              await t.$executeRawUnsafe(`DELETE FROM "WatchHistory" WHERE "id" = $1`, stored.id);
            }, { timeout: 10_000 + 2 * ms });
            await lockedItem;
          },
        },
      ]);

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });
      await other;

      expect(spy).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringContaining("SQLSTATE 40P01"),
      );
      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ mediaItemId: kept.id, serverUsername: "alice", watchedAt: T1 }),
      ]);
    }, 15_000);

    it("drops, in an incremental append, the plays of an item deleted after the item map was read", async () => {
      // The append's lock can wait behind a History-page Refresh too, and it
      // has no retry: unnarrowed, its INSERT failed on the foreign key.
      const url = await serve(
        plexRoute({ history: () => plexHistory([plexPlay("200", 1, T2), plexPlay("100", 1, T2)]) }),
      );
      const server = await createTestServer(userId, { type: "PLEX", url, watchHistorySyncedAt: ESTABLISHED });
      const library = await createTestLibrary(server.id, { key: "1" });
      const kept = await createTestMediaItem(library.id, { ratingKey: "100" });
      const victim = await createTestMediaItem(library.id, { ratingKey: "200" });
      // The newest stored play sets the window: T2 is inside it.
      await store({ mediaItemId: kept.id, mediaServerId: server.id, serverUsername: "bob", watchedAt: T2 });
      interceptTransactions([
        { before: async () => void (await prisma.mediaItem.delete({ where: { id: victim.id } })) },
      ]);

      await expect(
        syncWatchHistory(server.id, undefined, undefined, { incremental: true }),
      ).resolves.toEqual({ count: 1 });

      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ mediaItemId: kept.id, serverUsername: "alice", watchedAt: T2 }),
        expect.objectContaining({ mediaItemId: kept.id, serverUsername: "bob", watchedAt: T2 }),
      ]);
    });

    it("does not retry a write that lost the race after the sync was cancelled", async () => {
      // Stop pressed while the write fails on a real foreign key: a retry
      // would rebuild the item map and run the whole replace again for nobody,
      // only for its first batch to see the abort and roll it back.
      const { server, kept, victim } = await fixture();
      await store({ mediaItemId: kept.id, mediaServerId: server.id, serverUsername: "bob", watchedAt: T1 });
      const before = await rowsOf(server.id);
      const controller = new AbortController();
      const spy = interceptTransactions([
        {
          beforeFirstInsert: async () => {
            controller.abort();
            await prisma.mediaItem.delete({ where: { id: victim.id } });
          },
        },
      ]);

      // The write's own failure, not a second attempt's "cancelled".
      await expect(syncWatchHistory(server.id, undefined, controller.signal)).rejects.toMatchObject({
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "23503" } } },
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await rowsOf(server.id)).toEqual(before);
    });
  });
});
