/**
 * The Tracearr importer's end-of-run NATIVE purge only runs while the server
 * is still mapped to the Tracearr server the run read.
 *
 * The race: a run has written pages, the admin unlinks Tracearr (the server
 * PUT wipes the server's rows), and the History page's Refresh writes the
 * server's fresh native history. The purge used to run anyway — keyed on "this
 * run wrote something" — and deleted that native history while
 * `watchHistorySyncedAt` stayed set, so `watchedByUser is not X` matched the
 * whole library. Runs the real importer against the real database.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import type { TracearrHistoryRecord } from "@/lib/tracearr/tracearr-client";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));

const T = "aaaaaaaa-1111-2222-3333-444444444444";

const fake = vi.hoisted(() => ({
  pages: [] as Array<{ records: unknown[]; nextCursor: string | null }>,
  /** Runs before a page is handed back, keyed by its cursor. */
  beforePage: new Map<string, () => Promise<void>>(),
}));

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getServerAccountNames = async () => new Map([["u1", "weingart"]]);
    this.findOldestPlayAt = async () => null;
    this.listServers = async () => [{ id: T }];
    this.getHistoryPage = async (_id: string, opts: { cursor?: string }) => {
      await fake.beforePage.get(opts.cursor ?? "0")?.();
      return fake.pages[opts.cursor ? Number(opts.cursor) : 0] ?? { records: [], nextCursor: null };
    };
  },
}));

import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";

const prisma = getTestPrisma();
const HOUR = 3_600_000;

function play(id: string, ratingKey: string, startedAt: Date): TracearrHistoryRecord {
  return {
    id,
    reference_id: id,
    server_id: T,
    state: "stopped",
    media_type: "movie",
    rating_key: ratingKey,
    grandparent_rating_key: null,
    parent_rating_key: null,
    tmdb_id: null,
    imdb_id: null,
    tvdb_id: null,
    started_at: startedAt.toISOString(),
    stopped_at: new Date(startedAt.getTime() + HOUR).toISOString(),
    watched: true,
    percent_complete: 100,
    segment_count: 1,
    user: { id: "x", server_user_id: "u1", username: "Nick W" },
  } as unknown as TracearrHistoryRecord;
}

/** A Tracearr-mapped server with its archive walked and one stored play. */
async function setup() {
  const user = await createTestUser();
  await prisma.tracearrInstance.create({ data: { userId: user.id, name: "T", url: "http://t", apiKey: "k" } });
  const server = await createTestServer(user.id, {
    type: "PLEX",
    tracearrServerId: T,
    tracearrBackfillComplete: true,
  });
  const lib = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
  const a = await createTestMediaItem(lib.id, { ratingKey: "rk-a", title: "A" });
  const b = await createTestMediaItem(lib.id, { ratingKey: "rk-b", title: "B" });
  await prisma.watchHistory.create({
    data: {
      mediaItemId: a.id,
      mediaServerId: server.id,
      serverUsername: "weingart",
      watchedAt: new Date(Date.now() - 2 * HOUR),
      source: "TRACEARR",
      sourceEventId: "chain-stored",
      watched: true,
      state: "stopped",
    },
  });
  return { server, a, b };
}

/**
 * What the admin's unlink and the Refresh after it do to the server: the PUT
 * clears the mapping and wipes the rows, then the native full replace writes
 * the server's own history.
 */
async function unlinkAndRefreshNatively(serverId: string, itemId: string) {
  await prisma.mediaServer.update({
    where: { id: serverId },
    data: { tracearrServerId: null, tracearrBackfillComplete: false },
  });
  await prisma.watchHistory.deleteMany({ where: { mediaServerId: serverId } });
  await prisma.watchHistory.createMany({
    data: [
      { mediaItemId: itemId, mediaServerId: serverId, serverUsername: "weingart", watchedAt: new Date(), source: "NATIVE" },
      { mediaItemId: itemId, mediaServerId: serverId, serverUsername: "alice", watchedAt: new Date(), source: "NATIVE" },
    ],
  });
}

const nativeRows = (serverId: string) =>
  prisma.watchHistory.count({ where: { mediaServerId: serverId, source: "NATIVE" } });

beforeEach(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.tracearrInstance.deleteMany();
  await cleanDatabase();
  fake.pages = [];
  fake.beforePage.clear();
});
afterAll(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.tracearrInstance.deleteMany();
  await cleanDatabase();
  await disconnectTestDb();
});

describe("the end-of-run NATIVE purge", () => {
  it("keeps the fresh native history when the run stopped on a mapping change", async () => {
    const { server, b } = await setup();
    fake.pages = [
      { records: [play("chain-1", "rk-a", new Date(Date.now() - HOUR))], nextCursor: "1" },
      { records: [play("chain-2", "rk-b", new Date(Date.now() - 1.5 * HOUR))], nextCursor: null },
    ];
    // Page 2 is requested while page 1 is written. It is held until page 1 has
    // committed (the progress report follows the commit), and the admin's
    // unlink and the native Refresh land in between — so page 2's write finds
    // the mapping gone and the walk stops there, having written page 1.
    let page1Committed!: () => void;
    const committed = new Promise<void>((resolve) => (page1Committed = resolve));
    let unlinked = false;
    fake.beforePage.set("1", async () => {
      await committed;
      await unlinkAndRefreshNatively(server.id, b.id);
      unlinked = true;
    });

    const result = await syncTracearrHistory(server.id, {
      passes: "forward",
      onProgress: (progress) => {
        if ((progress.pages ?? 0) === 1) page1Committed();
      },
    });

    expect(unlinked).toBe(true);
    // Page 1 counted, so the run reached its end-of-run tail.
    expect(result.count).toBe(1);
    expect(await nativeRows(server.id)).toBe(2);
    // Nothing of the old source landed after the wipe either.
    expect(
      await prisma.watchHistory.count({ where: { mediaServerId: server.id, source: "TRACEARR" } }),
    ).toBe(0);
  });

  it("still removes a leftover native stratum while the mapping holds", async () => {
    const { server, b } = await setup();
    await prisma.watchHistory.create({
      data: { mediaItemId: b.id, mediaServerId: server.id, serverUsername: "weingart", watchedAt: new Date(), source: "NATIVE" },
    });
    fake.pages = [
      { records: [play("chain-1", "rk-a", new Date(Date.now() - HOUR))], nextCursor: null },
    ];

    await syncTracearrHistory(server.id, { passes: "forward" });

    expect(await nativeRows(server.id)).toBe(0);
  });
});
