/**
 * The Tracearr import's two boundaries, read off the stored rows by the real
 * watermark query: the forward pass asks for plays since `MAX(watchedAt)` less
 * the overlap (further back for a chain still open, never more than the 7-day
 * lookback), and the backfill for plays until `MIN(watchedAt)`. Only this
 * server's TRACEARR rows count. The unit tests stub the query; this runs it,
 * because it is three subqueries whose answers must stay exactly those of the
 * one aggregate they replaced.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestUser, createTestServer, createTestLibrary, createTestMediaItem } from "../../setup/test-helpers";

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

const T = "11111111-2222-3333-4444-555555555555";
const tracearr = vi.hoisted(() => ({
  requests: [] as Array<{ since?: Date; until?: Date }>,
}));

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getServerAccountNames = async () => new Map([["u1", "weingart"]]);
    this.getHistoryPage = async (_id: string, opts: { since?: Date; until?: Date }) => {
      tracearr.requests.push({ since: opts.since, until: opts.until });
      return { records: [], nextCursor: null };
    };
    this.findOldestPlayAt = async () => null;
    this.listServers = async () => [{ id: T }];
  },
}));

import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";

const prisma = getTestPrisma();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Row = {
  watchedAt: Date | null;
  source?: "TRACEARR" | "NATIVE";
  watched?: boolean | null;
  state?: string | null;
  serverId?: string;
};

async function setup(backfillComplete: boolean) {
  const user = await createTestUser();
  await prisma.tracearrInstance.create({ data: { userId: user.id, name: "T", url: "http://t", apiKey: "k" } });
  const server = await createTestServer(user.id, {
    type: "PLEX", tracearrServerId: T, tracearrBackfillComplete: backfillComplete,
  });
  const other = await createTestServer(user.id, { name: "Other", type: "PLEX" });
  const lib = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
  const item = await createTestMediaItem(lib.id, { ratingKey: "r1", title: "r1" });
  let n = 0;
  const store = async (rows: Row[]) => {
    for (const row of rows) {
      n++;
      const source = row.source ?? "TRACEARR";
      await prisma.watchHistory.create({
        data: {
          mediaItemId: item.id,
          mediaServerId: row.serverId ?? server.id,
          serverUsername: "weingart",
          watchedAt: row.watchedAt,
          source,
          sourceEventId: source === "TRACEARR" ? `c${n}` : null,
          watched: row.watched === undefined ? (source === "TRACEARR" ? true : null) : row.watched,
          state: row.state === undefined ? (source === "TRACEARR" ? "stopped" : null) : row.state,
        },
      });
    }
  };
  return { server, other, store };
}

beforeEach(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.tracearrInstance.deleteMany();
  await cleanDatabase();
  tracearr.requests = [];
});
afterAll(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.tracearrInstance.deleteMany();
  await cleanDatabase();
  await disconnectTestDb();
});

describe("Tracearr forward window", () => {
  const max = new Date(Date.now() - 2 * DAY);

  it("starts an hour before the newest TRACEARR play, ignoring native rows and other servers", async () => {
    const { server, other, store } = await setup(true);
    await store([
      { watchedAt: max },
      { watchedAt: new Date(max.getTime() - 3 * DAY) },
      // Newer, but neither counts: a native row, and another server's import.
      { watchedAt: new Date(max.getTime() + DAY), source: "NATIVE" },
      { watchedAt: new Date(max.getTime() + DAY), serverId: other.id },
      // MAX and MIN skip a row with no timestamp.
      { watchedAt: null },
    ]);

    await syncTracearrHistory(server.id, { passes: "forward" });

    expect(tracearr.requests.map((r) => r.since?.getTime())).toEqual([max.getTime() - HOUR]);
  });

  it("reaches back to a chain still open inside the lookback", async () => {
    const { server, store } = await setup(true);
    const open = new Date(max.getTime() - 3 * HOUR);
    await store([
      { watchedAt: max },
      { watchedAt: open, state: "playing" },
      // Finished, so it does not hold the window open.
      { watchedAt: new Date(max.getTime() - 2 * DAY) },
    ]);

    await syncTracearrHistory(server.id, { passes: "forward" });

    expect(tracearr.requests.map((r) => r.since?.getTime())).toEqual([open.getTime()]);
  });

  it("counts an unfinished play as open, and clamps an old one to the 7-day lookback", async () => {
    const { server, store } = await setup(true);
    await store([
      { watchedAt: max },
      // An abandoned play from a month earlier: watched false, stopped.
      { watchedAt: new Date(max.getTime() - 30 * DAY), watched: false },
    ]);

    await syncTracearrHistory(server.id, { passes: "forward" });

    expect(tracearr.requests.map((r) => r.since?.getTime())).toEqual([max.getTime() - 7 * DAY]);
  });

  it("does not hold the window open for a row whose completion is unknown", async () => {
    const { server, store } = await setup(true);
    await store([
      { watchedAt: max },
      // `state` NULL: neither predicate is true, so it is not an open chain.
      { watchedAt: new Date(max.getTime() - 5 * HOUR), watched: true, state: null },
    ]);

    await syncTracearrHistory(server.id, { passes: "forward" });

    expect(tracearr.requests.map((r) => r.since?.getTime())).toEqual([max.getTime() - HOUR]);
  });
});

describe("Tracearr backfill boundary", () => {
  it("walks older than the oldest TRACEARR play this server holds", async () => {
    const { server, other, store } = await setup(false);
    const oldest = new Date(Date.now() - 40 * DAY);
    await store([
      { watchedAt: new Date(Date.now() - DAY) },
      { watchedAt: oldest },
      // Older, but neither counts.
      { watchedAt: new Date(oldest.getTime() - DAY), source: "NATIVE" },
      { watchedAt: new Date(oldest.getTime() - DAY), serverId: other.id },
    ]);

    await syncTracearrHistory(server.id, { passes: "backfill" });

    expect(tracearr.requests.map((r) => r.until?.getTime())).toEqual([oldest.getTime()]);
  });
});
