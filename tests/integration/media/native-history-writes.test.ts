/**
 * The native full replace and incremental append against a real database, through the REAL
 * Plex/Jellyfin/Emby clients talking to a local fake server, so every guard runs as in production.
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
 * Run `hooks[n]` around the n-th interactive transaction: `before` it starts,
 * or just before its first WatchHistory INSERT (after the in-transaction checks).
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
    vi.mocked(logger.info).mockClear();
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

  /** A server (established Plex unless told otherwise) behind `route`; one library, an item per key. */
  async function setup(
    route: FakeRoute,
    ratingKeys: string[],
    server: Parameters<typeof createTestServer>[1] = {},
  ) {
    fake = await startFakeMediaServer(route);
    const srv = await createTestServer(userId, {
      type: "PLEX",
      watchHistorySyncedAt: ESTABLISHED,
      url: fake.url,
      ...server,
    });
    const library = await createTestLibrary(srv.id, { key: "1" });
    const items: Record<string, { id: string }> = {};
    for (const ratingKey of ratingKeys) {
      items[ratingKey] = await createTestMediaItem(library.id, { ratingKey, title: ratingKey });
    }
    return { server: srv, items };
  }

  const rowsOf = (serverId: string) =>
    prisma.watchHistory.findMany({
      where: { mediaServerId: serverId },
      orderBy: [{ serverUsername: "asc" }, { watchedAt: "asc" }],
      select: { mediaItemId: true, serverUsername: true, watchedAt: true, deviceName: true, platform: true, source: true },
    });
  const markerOf = async (serverId: string) =>
    (await prisma.mediaServer.findUniqueOrThrow({ where: { id: serverId } })).watchHistorySyncedAt;
  const store = (data: Parameters<typeof prisma.watchHistory.create>[0]["data"]) =>
    prisma.watchHistory.create({ data });
  const completeness = (serverId: string) => checkWatchHistoryCompleteness(userId, [serverId]);

  describe("a Jellyfin/Emby user whose listing cannot be read completely", () => {
    /** An empty first page under a non-zero total: bob's items are all hidden from the key. */
    const hiddenItems = () => ({ body: { Items: [], TotalRecordCount: 5 } });
    const refused = () => ({ status: 403, body: { error: "forbidden" } });
    /** Every page the same full first page. */
    const ignoresStartIndex = () => ({
      body: { Items: Array.from({ length: 1000 }, (_, i) => played(`m-${i}`)), TotalRecordCount: 1500 },
    });

    /** Items m-a and m-b (bob's, stored at T1 when `bobStored`). */
    async function server(
      route: Parameters<typeof jellyfinRoute>[0],
      options: { type?: "JELLYFIN" | "EMBY"; marker?: Date | null; bobStored?: boolean } = {},
    ) {
      const { server: srv, items } = await setup(jellyfinRoute(route), ["m-a", "m-b"], {
        type: options.type ?? "JELLYFIN",
        watchHistorySyncedAt: options.marker === undefined ? ESTABLISHED : options.marker,
      });
      if (options.bobStored) {
        await store({ mediaItemId: items["m-b"].id, mediaServerId: srv.id, serverUsername: "bob", watchedAt: T1 });
      }
      return { server: srv, a: items["m-a"], b: items["m-b"] };
    }

    it.each([
      { type: "JELLYFIN", bob: hiddenItems, why: "listing incomplete", product: "Jellyfin" },
      { type: "EMBY", bob: hiddenItems, why: "listing incomplete", product: "Emby" },
      { type: "JELLYFIN", bob: refused, why: "refused", product: "Jellyfin" },
    ] as const)("$type: keeps the stored plays of a user set aside ($why) and replaces everyone else's", async ({ type, bob, why, product }) => {
      const { server: srv, a, b } = await server({ alice: [played("m-a", T2)], bob }, { type, bobStored: true });
      // alice's old play, which her listing no longer reports.
      await store({ mediaItemId: b.id, mediaServerId: srv.id, serverUsername: "alice", watchedAt: T1 });

      await expect(syncWatchHistory(srv.id)).resolves.toEqual({ count: 1 });

      expect(await rowsOf(srv.id)).toEqual([
        expect.objectContaining({ mediaItemId: a.id, serverUsername: "alice", watchedAt: T2 }),
        expect.objectContaining({ mediaItemId: b.id, serverUsername: "bob", watchedAt: T1 }),
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        "WatchHistory",
        `Not replacing the stored plays of "bob" (${why}) on "Test Server": ` +
          "their watch history could not be read completely this sync. Their plays that are " +
          "not stored already — new ones, and every play of media added or re-added since " +
          "(a newly enabled, purged or re-created library) — stay missing until their listing " +
          "can be read, and an item they alone watched reads as never played unless one of " +
          `its plays is stored. Make their played items readable in ${product} (their library ` +
          "access, parental controls) or remove the user there",
      );
      // Re-established: bob's rows stand, so nothing became vacuous.
      expect((await markerOf(srv.id))!.getTime()).toBeGreaterThan(ESTABLISHED.getTime());
      expect(await completeness(srv.id)).toEqual({ complete: true });
    });

    it.each([
      { path: "alice's plays", alice: [played("m-a")], count: 1 },
      { path: "the empty-history path", alice: [], count: 0 },
    ])("does not establish a never-established history while an unreliable user has nothing stored ($path)", async ({ alice, count }) => {
      const { server: srv, a } = await server({ alice, bob: hiddenItems }, { marker: null });

      // The readable users' rows are still committed.
      await expect(syncWatchHistory(srv.id)).resolves.toEqual({ count });

      expect(await rowsOf(srv.id)).toEqual(
        count ? [expect.objectContaining({ mediaItemId: a.id, serverUsername: "alice" })] : [],
      );
      expect(await markerOf(srv.id)).toBeNull();
      expect((await completeness(srv.id)).complete).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        "WatchHistory",
        expect.stringMatching(
          /Not marking .*established.*"bob".*stay paused\. Make their played items readable in Jellyfin \(their library access, parental controls\) or remove the user there — a Refresh alone does not lift this/,
        ),
      );
      // Nor does a Refresh while bob stays unreadable.
      await syncWatchHistory(srv.id);
      expect(await markerOf(srv.id)).toBeNull();
    });

    it("establishes a null-marker history when bob's stored rows survive — they vouch for him", async () => {
      // Every hold release nulls the marker; refusing here paused such a server for good.
      const { server: srv, b } = await server({ alice: [played("m-a")], bob: hiddenItems }, { marker: null, bobStored: true });

      await expect(syncWatchHistory(srv.id)).resolves.toEqual({ count: 1 });

      expect((await rowsOf(srv.id)).filter((r) => r.serverUsername === "bob")).toEqual([
        expect.objectContaining({ mediaItemId: b.id }),
      ]);
      expect(await markerOf(srv.id)).not.toBeNull();
      expect(await completeness(srv.id)).toEqual({ complete: true });
    });

    it("counts only the server's own rows: bob's plays on ANOTHER server do not stand in", async () => {
      const { server: srv } = await server({ alice: [played("m-a")], bob: hiddenItems }, { marker: null });
      const other = await createTestServer(userId, { type: "JELLYFIN", name: "Other" });
      const otherLib = await createTestLibrary(other.id, { key: "x" });
      const otherItem = await createTestMediaItem(otherLib.id, { ratingKey: "o-1" });
      await store({ mediaItemId: otherItem.id, mediaServerId: other.id, serverUsername: "bob", watchedAt: T1 });

      await expect(syncWatchHistory(srv.id)).resolves.toEqual({ count: 1 });

      expect(await markerOf(srv.id)).toBeNull();
    });

    it("establishes a fresh server with only a REFUSED user set aside", async () => {
      // The key will never read bob: waiting for him would block the server for good.
      const { server: srv } = await server({ alice: [played("m-a")], bob: refused }, { marker: null });

      await expect(syncWatchHistory(srv.id)).resolves.toEqual({ count: 1 });

      expect(await markerOf(srv.id)).not.toBeNull();
      expect(await completeness(srv.id)).toEqual({ complete: true });
    });

    it.each([
      { failure: "a proxy ignores StartIndex (fresh server)", route: { alice: [played("m-a")], bob: ignoresStartIndex }, marker: null, error: /ignored StartIndex/ },
      { failure: "a proxy ignores StartIndex", route: { alice: [played("m-a")], bob: ignoresStartIndex }, marker: ESTABLISHED, error: /ignored StartIndex/ },
      { failure: "no user could be read", route: { alice: hiddenItems, bob: refused }, marker: ESTABLISHED, error: /fetch failed.*all 2 user/ },
      { failure: "a page is malformed", route: { alice: [played("m-a", T2)], bob: () => ({ body: { TotalRecordCount: 5 } }) }, marker: ESTABLISHED, error: /no Items list/ },
    ])("fails the sync, touching nothing, when $failure", async ({ route, marker, error }) => {
      // A set-aside multi-page user under an ignored offset used to leave an
      // EMPTY history established on a fresh server.
      const { server: srv } = await server(route, { marker, bobStored: true });
      const before = await rowsOf(srv.id);

      await expect(syncWatchHistory(srv.id)).resolves.toEqual({ count: 0, failed: expect.stringMatching(error) });

      expect(await rowsOf(srv.id)).toEqual(before);
      expect(await markerOf(srv.id)).toEqual(marker);
    });
  });

  describe("Plex device names when /devices fails", () => {
    /** Items 100 (alice's play at T1 stored on the Roku) and 200. */
    async function fixture(devices: () => FakeResponse, history: Array<Record<string, unknown>>) {
      const { server, items } = await setup(plexRoute({ devices, history: () => plexHistory(history) }), ["100", "200"]);
      await store({
        mediaItemId: items["100"].id,
        mediaServerId: server.id,
        serverUsername: "alice",
        watchedAt: T1,
        deviceName: "Roku",
        platform: "Roku OS",
      });
      return { server, known: items["100"], fresh: items["200"] };
    }

    it.each([
      ["answers with an error", () => ({ status: 403, body: { error: "forbidden" } })],
      ["answers with a page that is not a device list", () => ({ body: "<html>Sign in</html>" })],
    ])("keeps the stored device of every re-delivered play when /devices %s", async (_label, devices) => {
      const { server, known, fresh } = await fixture(devices as () => FakeResponse, [
        plexPlay("200", 1, T2, { deviceID: 7 }),
        plexPlay("100", 1, T1, { deviceID: 7 }),
      ]);

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 2 });

      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ mediaItemId: known.id, watchedAt: T1, deviceName: "Roku", platform: "Roku OS" }),
        // A new play has nothing stored to keep.
        expect.objectContaining({ mediaItemId: fresh.id, watchedAt: T2, deviceName: null, platform: null }),
      ]);
      expect(logger.warn).toHaveBeenCalledWith("WatchHistory", expect.stringContaining("did not answer its device list"));
    });

    it("replaces the stored device when /devices answers, and never carries a stale one over", async () => {
      // 100's play comes back with a device the list does not name: no Roku.
      const { server, known, fresh } = await fixture(
        () => ({ body: { MediaContainer: { Device: [{ id: 7, name: "Shield", platform: "Android" }] } } }),
        [plexPlay("200", 1, T2, { deviceID: 7 }), plexPlay("100", 1, T1, { deviceID: 99 })],
      );

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 2 });

      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ mediaItemId: known.id, deviceName: null, platform: null }),
        expect.objectContaining({ mediaItemId: fresh.id, deviceName: "Shield", platform: "Android" }),
      ]);
    });

    it("matches a stored device by account too: another account's play at the same second keeps nothing", async () => {
      const { server } = await fixture(() => ({ status: 403, body: {} }), [plexPlay("100", 2, T1, { deviceID: 7 })]);

      await syncWatchHistory(server.id);

      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ serverUsername: "bob", deviceName: null, platform: null }),
      ]);
    });
  });

  describe("the realtime refresh while a library-resync hold is set", () => {
    // The incremental refresh used to require the marker, so under a hold every
    // finished playback ran the whole full replace, which could not mark it.
    async function plexServer(options: { marker: Date | null; held: boolean; stored: boolean }) {
      const { server, items } = await setup(
        plexRoute({ history: async () => plexHistory([plexPlay("100", 2, T2), plexPlay("100", 1, T1)]) }),
        ["100"],
        { watchHistorySyncedAt: options.marker },
      );
      if (options.held) {
        await prisma.mediaServer.update({ where: { id: server.id }, data: { libraryResyncRequiredAt: new Date() } });
      }
      if (options.stored) {
        await store({ mediaItemId: items["100"].id, mediaServerId: server.id, serverUsername: "alice", watchedAt: T1 });
      }
      return { server, item: items["100"] };
    }
    const refresh = (serverId: string) =>
      syncWatchHistory(serverId, undefined, undefined, { incremental: true });
    // Decoded: axios sends the `>` of `viewedAt>=` percent-encoded.
    const historyRequests = () =>
      fake!.urls
        .filter((url) => url.startsWith("/status/sessions/history/all"))
        .map((url) => decodeURIComponent(url));

    it("appends while held, when there are rows to resume from, and leaves the marker null", async () => {
      const { server, item } = await plexServer({ marker: null, held: true, stored: true });

      // bob's play is new; alice's is the stored one, re-delivered.
      await expect(refresh(server.id)).resolves.toEqual({ count: 1 });

      // From an hour before the newest stored play.
      expect(historyRequests()).toEqual([expect.stringContaining(`viewedAt>=${epoch(T1) - 3600}`)]);
      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ mediaItemId: item.id, serverUsername: "alice", watchedAt: T1 }),
        expect.objectContaining({ mediaItemId: item.id, serverUsername: "bob", watchedAt: T2 }),
      ]);
      // Still held, and no "Not marking" line at info level per playback.
      expect(await markerOf(server.id)).toBeNull();
      expect(vi.mocked(logger.info).mock.calls.filter((call) => String(call[1]).includes("Not marking"))).toEqual([]);
    });

    it.each([
      { state: "held with nothing to resume from", marker: null, held: true, stored: false, count: 2, append: false },
      { state: "released (marker and hold both null)", marker: null, held: false, stored: true, count: 2, append: false },
      { state: "established", marker: ESTABLISHED, held: false, stored: true, count: 1, append: true },
    ])("$state: append=$append", async ({ marker, held, stored, count, append }) => {
      const { server } = await plexServer({ marker, held, stored });

      await expect(refresh(server.id)).resolves.toEqual({ count });

      const requests = historyRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].includes("viewedAt>=")).toBe(append);
      const after = await markerOf(server.id);
      if (held) expect(after).toBeNull();
      else expect(after!.getTime()).toBeGreaterThan(marker?.getTime() ?? 0);
    });
  });

  describe("why the history was not marked established", () => {
    // Two refusals, two remedies; the log used to blame a withdrawal for both.
    const infoLines = () => vi.mocked(logger.info).mock.calls.map((call) => String(call[1]));

    it("names the library-resync hold, which only a complete library sync settles", async () => {
      const { server } = await setup(plexRoute({ history: () => plexHistory([plexPlay("100", 1, T1)]) }), ["100"], {
        watchHistorySyncedAt: null,
      });
      await prisma.mediaServer.update({ where: { id: server.id }, data: { libraryResyncRequiredAt: new Date() } });

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

      expect(await markerOf(server.id)).toBeNull();
      expect(infoLines().some((line) => line.includes("complete library sync"))).toBe(true);
      expect(infoLines().some((line) => line.includes("withdrawn or re-established"))).toBe(false);
    });

    it("names a withdrawal while the sync ran, which the next sync settles", async () => {
      const ids = { serverId: "" };
      const { server } = await setup(
        plexRoute({
          history: async () => {
            // A purge's withdrawal, landing mid-fetch.
            await prisma.mediaServer.update({ where: { id: ids.serverId }, data: { watchHistorySyncedAt: null } });
            return plexHistory([plexPlay("100", 1, T1)]);
          },
        }),
        ["100"],
      );
      ids.serverId = server.id;

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

      expect(await markerOf(server.id)).toBeNull();
      expect(infoLines().some((line) => line.includes("withdrawn or re-established"))).toBe(true);
      expect(infoLines().some((line) => line.includes("complete library sync"))).toBe(false);
    });
  });

  it("fails a Plex sync whose history listing ends far short of its total, touching nothing", async () => {
    // `{ totalSize: 141000, size: 0 }` used to commit an empty history.
    const { server, items } = await setup(
      plexRoute({ history: () => ({ body: { MediaContainer: { totalSize: 141000, size: 0 } } }) }),
      ["100"],
    );
    await store({ mediaItemId: items["100"].id, mediaServerId: server.id, serverUsername: "alice", watchedAt: T1 });

    await expect(syncWatchHistory(server.id)).resolves.toEqual({
      count: 0,
      failed: expect.stringContaining("ended at 0 of a reported 141000"),
    });
    expect(await rowsOf(server.id)).toHaveLength(1);
    expect(await markerOf(server.id)).toEqual(ESTABLISHED);
  });

  describe("a server mapped to Tracearr while the native fetch ran", () => {
    /** What the server PUT (wipe + mapping, under the same lock) and a backfill slice do mid-fetch. */
    async function mapToTracearr(serverId: string, itemId: string) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('watch-history:' || $1))`, serverId);
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

    /** Item 100 with alice's play stored at T1; `history` answers the fetch. */
    async function fixture(history: (ids: { serverId: string; itemId: string }) => Promise<FakeResponse>) {
      const ids = { serverId: "", itemId: "" };
      const { server, items } = await setup(plexRoute({ history: () => history(ids) }), ["100"]);
      await store({ mediaItemId: items["100"].id, mediaServerId: server.id, serverUsername: "alice", watchedAt: T1 });
      ids.serverId = server.id;
      ids.itemId = items["100"].id;
      return { server };
    }

    it.each([
      { path: "full replace", entries: [plexPlay("100", 1, T1)], incremental: false },
      { path: "empty history", entries: [], incremental: false },
      { path: "incremental append", entries: [plexPlay("100", 2, new Date(T1.getTime() + 60_000))], incremental: true },
    ])("$path: writes nothing, and reports the change", async ({ entries, incremental }) => {
      const { server } = await fixture(async (ids) => {
        await mapToTracearr(ids.serverId, ids.itemId);
        return plexHistory(entries);
      });

      await expect(syncWatchHistory(server.id, undefined, undefined, { incremental })).resolves.toEqual({
        count: 0,
        failed: SOURCE_CHANGED,
      });

      // The path under test really ran (an append fetches with `viewedAt>=`).
      expect(fake!.urls.some((url) => decodeURIComponent(url).includes("viewedAt>="))).toBe(incremental);
      expect(await rowsOf(server.id)).toEqual([expect.objectContaining({ source: "TRACEARR", watchedAt: T2 })]);
      // Not re-established over the importer's history.
      expect(await markerOf(server.id)).toEqual(ESTABLISHED);
    });

    it("a server deleted mid-fetch: writes nothing, and reports it rather than throwing", async () => {
      const { server } = await fixture(async (ids) => {
        await prisma.mediaServer.delete({ where: { id: ids.serverId } });
        return plexHistory([plexPlay("100", 1, T1)]);
      });

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 0, failed: SOURCE_CHANGED });
      expect(await prisma.watchHistory.count()).toBe(0);
    });
  });

  describe("an item deleted while the full replace is pending or running", () => {
    /** Items 100 and 200 (and 300 when asked); the history holds alice's play of each. */
    async function fixture(options: { withThird?: boolean } = {}) {
      const { server, items } = await setup(
        plexRoute({
          history: () =>
            plexHistory([
              ...(options.withThird ? [plexPlay("300", 1, T2)] : []),
              plexPlay("200", 1, T2),
              plexPlay("100", 1, T1),
            ]),
        }),
        options.withThird ? ["100", "200", "300"] : ["100", "200"],
      );
      return { server, kept: items["100"], victim: items["200"], third: items["300"] };
    }
    const deleteItem = (id: string) => async () => void (await prisma.mediaItem.delete({ where: { id } }));
    const fkViolation = { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "23503" } } } };

    it("drops the plays of an item deleted after the item map was read, and commits the rest in one go", async () => {
      const { server, kept, victim } = await fixture();
      // Its stored play goes with it (cascade).
      await store({ mediaItemId: victim.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: T1 });
      const spy = interceptTransactions([{ before: deleteItem(victim.id) }]);

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

      expect(await rowsOf(server.id)).toEqual([expect.objectContaining({ mediaItemId: kept.id })]);
      // Narrowed in the first transaction, not rescued by the retry.
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("re-picks the primary copy when the copy that would have held it was deleted", async () => {
      const { server } = await setup(jellyfinRoute({ alice: [played("jf-1", T1)] }), [], { type: "JELLYFIN" });
      const libA = await createTestLibrary(server.id, { key: "lib-a" });
      const libB = await createTestLibrary(server.id, { key: "lib-b" });
      const a = await createTestMediaItem(libA.id, { ratingKey: "jf-1" });
      const b = await createTestMediaItem(libB.id, { ratingKey: "jf-1" });
      const [primary, survivor] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
      const spy = interceptTransactions([{ before: deleteItem(primary.id) }]);

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
      const { server, kept, victim } = await fixture();
      await store({ mediaItemId: kept.id, mediaServerId: server.id, serverUsername: "bob", watchedAt: T1 });
      const spy = interceptTransactions([{ beforeFirstInsert: deleteItem(victim.id) }]);

      await expect(syncWatchHistory(server.id)).resolves.toEqual({ count: 1 });

      expect(spy).toHaveBeenCalledTimes(2);
      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ mediaItemId: kept.id, serverUsername: "alice", watchedAt: T1 }),
      ]);
      expect(logger.warn).toHaveBeenCalledWith("WatchHistory", expect.stringContaining("SQLSTATE 23503"));
    });

    it("lets a second failure propagate, with the stored history rolled back to what it was", async () => {
      const { server, kept, victim, third } = await fixture({ withThird: true });
      await store({ mediaItemId: kept.id, mediaServerId: server.id, serverUsername: "bob", watchedAt: T1 });
      const before = await rowsOf(server.id);
      // A different item goes under each attempt's write.
      const spy = interceptTransactions([
        { beforeFirstInsert: deleteItem(victim.id) },
        { beforeFirstInsert: deleteItem(third.id) },
      ]);

      await expect(syncWatchHistory(server.id)).rejects.toMatchObject(fkViolation);

      expect(spy).toHaveBeenCalledTimes(2);
      expect(await rowsOf(server.id)).toEqual(before);
    });

    it("retries once after losing a real deadlock to a concurrent writer", async () => {
      // A second transaction locks item 100 and, once the replace waits on it,
      // deletes a row the replace already holds. The replace waited first, so
      // Postgres aborts it (40P01).
      const { server, kept, victim } = await fixture();
      await prisma.mediaItem.delete({ where: { id: victim.id } });
      const stored = await store({ mediaItemId: kept.id, mediaServerId: server.id, serverUsername: "bob", watchedAt: T1 });
      // The replace checks for the cycle when its `deadlock_timeout` expires; the
      // other side joins at a third of it, whatever the server is configured with.
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
      expect(logger.warn).toHaveBeenCalledWith("WatchHistory", expect.stringContaining("SQLSTATE 40P01"));
      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ mediaItemId: kept.id, serverUsername: "alice", watchedAt: T1 }),
      ]);
    }, 15_000);

    it("drops, in an incremental append, the plays of an item deleted after the item map was read", async () => {
      // The append has no retry: unnarrowed, its INSERT failed on the foreign key.
      const { server, items } = await setup(
        plexRoute({ history: () => plexHistory([plexPlay("200", 1, T2), plexPlay("100", 1, T2)]) }),
        ["100", "200"],
      );
      // The newest stored play sets the window: T2 is inside it.
      await store({ mediaItemId: items["100"].id, mediaServerId: server.id, serverUsername: "bob", watchedAt: T2 });
      interceptTransactions([{ before: deleteItem(items["200"].id) }]);

      await expect(
        syncWatchHistory(server.id, undefined, undefined, { incremental: true }),
      ).resolves.toEqual({ count: 1 });

      expect(await rowsOf(server.id)).toEqual([
        expect.objectContaining({ mediaItemId: items["100"].id, serverUsername: "alice", watchedAt: T2 }),
        expect.objectContaining({ mediaItemId: items["100"].id, serverUsername: "bob", watchedAt: T2 }),
      ]);
    });

    it("does not retry a write that lost the race after the sync was cancelled", async () => {
      // A retry would rebuild and rerun the replace only to roll it back.
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
      await expect(syncWatchHistory(server.id, undefined, controller.signal)).rejects.toMatchObject(fkViolation);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await rowsOf(server.id)).toEqual(before);
    });
  });
});
