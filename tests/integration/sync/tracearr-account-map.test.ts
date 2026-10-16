/**
 * A Tracearr forward pass that cannot load the account-name map. It used to
 * import anyway, filing every play in its window under Tracearr's identity
 * label ("Nick W") instead of the server's account name ("weingart"), on the
 * argument that the next healthy run re-delivers and re-labels them. That holds
 * only inside the next run's `MAX(watchedAt) - 1h` window, while the forward
 * window itself is unbounded — and the next healthy run re-established the
 * evidence marker over the rows left mislabelled, so play-activity rules
 * resumed against the wrong names. It now imports nothing without the map.
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
  records: [] as Array<Record<string, unknown>>,
  accountsFail: false,
}));

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getServerAccountNames = async () => {
      if (tracearr.accountsFail) throw new Error("users endpoint 500");
      return new Map([["u1", "weingart"]]);
    };
    // Newest first, honouring `since`/`until` like the real keyset.
    this.getHistoryPage = async (_id: string, opts: { since?: Date; until?: Date }) => {
      const records = tracearr.records
        .filter((r) => !opts.since || new Date(r.started_at as string) >= opts.since)
        .filter((r) => !opts.until || new Date(r.started_at as string) <= opts.until)
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
      return { records, nextCursor: null };
    };
    this.findOldestPlayAt = async () => null;
    this.listServers = async () => [{ id: T }];
  },
}));

import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";

const prisma = getTestPrisma();

function play(id: string, ratingKey: string, startedAt: Date) {
  return {
    id, reference_id: id, server_id: T, state: "stopped", media_type: "movie",
    rating_key: ratingKey, grandparent_rating_key: null, parent_rating_key: null,
    tmdb_id: null, imdb_id: null, tvdb_id: null,
    started_at: startedAt.toISOString(),
    stopped_at: new Date(startedAt.getTime() + 3_600_000).toISOString(),
    watched: true, percent_complete: 100, segment_count: 1,
    user: { id: "x", server_user_id: "u1", username: "Nick W" },
  };
}

beforeEach(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.tracearrInstance.deleteMany();
  await cleanDatabase();
  tracearr.accountsFail = false;
});
afterAll(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.tracearrInstance.deleteMany();
  await cleanDatabase();
  await disconnectTestDb();
});

describe("Tracearr forward pass without the account map", () => {
  it("imports nothing, then imports every play under the account name once the map is back", async () => {
    const user = await createTestUser();
    await prisma.tracearrInstance.create({ data: { userId: user.id, name: "T", url: "http://t", apiKey: "k" } });
    const establishedAt = new Date(Date.now() - 86_400_000);
    const ms = await createTestServer(user.id, {
      type: "PLEX", tracearrServerId: T, tracearrBackfillComplete: true, watchHistorySyncedAt: establishedAt,
    });
    const lib = await createTestLibrary(ms.id, { key: "1", type: "MOVIE" });
    const items = await Promise.all(
      ["r0", "r1", "r2", "r3"].map((rk) => createTestMediaItem(lib.id, { ratingKey: rk, title: rk })),
    );

    // One play already imported, correctly labelled.
    const t0 = new Date(Date.now() - 10 * 3_600_000);
    await prisma.watchHistory.create({
      data: {
        mediaItemId: items[0].id, mediaServerId: ms.id, serverUsername: "weingart", watchedAt: t0,
        source: "TRACEARR", sourceEventId: "c0", watched: true, state: "stopped",
      },
    });
    // Three new plays over the next few hours — far more than the 1h overlap.
    tracearr.records = [
      play("c0", "r0", t0),
      play("c1", "r1", new Date(t0.getTime() + 1 * 3_600_000)),
      play("c2", "r2", new Date(t0.getTime() + 3 * 3_600_000)),
      play("c3", "r3", new Date(t0.getTime() + 5 * 3_600_000)),
    ];

    tracearr.accountsFail = true;
    await expect(syncTracearrHistory(ms.id, { passes: "forward" })).resolves.toMatchObject({ count: 0 });
    expect(await prisma.watchHistory.count()).toBe(1);
    // Nothing was written, so nothing needed withdrawing.
    expect(
      (await prisma.mediaServer.findUniqueOrThrow({ where: { id: ms.id } })).watchHistorySyncedAt,
    ).toEqual(establishedAt);

    tracearr.accountsFail = false;
    await syncTracearrHistory(ms.id, { passes: "forward" });

    const rows = await prisma.watchHistory.findMany({ orderBy: { watchedAt: "asc" } });
    expect(rows.map((r) => [r.sourceEventId, r.serverUsername])).toEqual([
      ["c0", "weingart"],
      ["c1", "weingart"],
      ["c2", "weingart"],
      ["c3", "weingart"],
    ]);
  });
});
