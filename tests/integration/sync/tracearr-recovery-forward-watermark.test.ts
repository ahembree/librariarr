/**
 * Recovering a re-added item's plays does not move the forward pass past
 * plays it has not read.
 *
 * The forward `since` is read off the newest stored play. Recovery stores a
 * few items' plays wherever they fall, so one newer than the newest stored
 * play used to move the next forward window above every play in between —
 * plays nothing had read, and that nothing would read again, since the
 * backfill only walks older than the oldest row. The real candidate query,
 * importer and forward pass against the real database, with a fake Tracearr
 * that answers both the per-item lookup and the paged history.
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

const T = "eeeeeeee-1111-2222-3333-444444444444";

const fake = vi.hoisted(() => ({
  /** Every play Tracearr holds for the server, newest first. */
  archive: [] as TracearrHistoryRecord[],
  pageSize: 2,
  pageRequests: [] as Array<{ since?: Date; until?: Date; cursor?: string }>,
}));

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getServerAccountNames = async () => new Map([["u1", "weingart"]]);
    this.findOldestPlayAt = async () => null;
    this.listServers = async () => [{ id: T }];
    this.getHistoryForItem = async (_id: string, filter: { ratingKey?: string }) =>
      filter.ratingKey ? fake.archive.filter((p) => p.rating_key === filter.ratingKey) : [];
    this.getHistoryPage = async (
      _id: string,
      opts: { since?: Date; until?: Date; cursor?: string },
    ) => {
      fake.pageRequests.push({ since: opts.since, until: opts.until, cursor: opts.cursor });
      const inWindow = fake.archive.filter((record) => {
        const at = new Date(record.started_at).getTime();
        return (!opts.since || at >= opts.since.getTime()) && (!opts.until || at <= opts.until.getTime());
      });
      const offset = opts.cursor ? Number(opts.cursor) : 0;
      const end = offset + fake.pageSize;
      return {
        records: inWindow.slice(offset, end),
        nextCursor: end < inWindow.length ? String(end) : null,
      };
    };
  },
}));

import {
  recoverHistoryForNewItems,
  resetRecoveryAnswers,
} from "@/lib/sync/tracearr-backfill-additions";
import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";

const prisma = getTestPrisma();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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

/**
 * A fully walked server whose stored plays end at T0, five days ago; an item
 * re-added a day ago, whose lost play (T0 + 3 days) is what recovery finds;
 * and a play at T0 + 1 day that no forward pass has read yet.
 */
async function setup() {
  const now = Date.now();
  const t0 = new Date(now - 5 * DAY);
  const user = await createTestUser();
  await prisma.tracearrInstance.create({ data: { userId: user.id, name: "T", url: "http://t", apiKey: "k" } });
  const server = await createTestServer(user.id, {
    type: "PLEX",
    tracearrServerId: T,
    tracearrBackfillComplete: true,
  });
  const lib = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
  const item = async (ratingKey: string, addedAgo: number) => {
    const created = await createTestMediaItem(lib.id, { ratingKey, title: ratingKey });
    await prisma.mediaItem.update({
      where: { id: created.id },
      data: { createdAt: new Date(now - addedAgo) },
    });
    return created.id;
  };
  const stored = await item("rk-stored", 30 * DAY);
  await item("rk-unread", 30 * DAY);
  const readded = await item("rk-readded", DAY);

  await prisma.watchHistory.create({
    data: {
      mediaItemId: stored,
      mediaServerId: server.id,
      serverUsername: "weingart",
      watchedAt: t0,
      source: "TRACEARR",
      sourceEventId: "chain-stored",
      watched: true,
      state: "stopped",
    },
  });
  fake.archive = [
    play("chain-recovered", "rk-readded", new Date(t0.getTime() + 3 * DAY)),
    play("chain-unread", "rk-unread", new Date(t0.getTime() + DAY)),
    play("chain-stored", "rk-stored", t0),
  ];
  return { server, t0, readded };
}

const readServer = (id: string) => prisma.mediaServer.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.tracearrInstance.deleteMany();
  await cleanDatabase();
  resetRecoveryAnswers();
  fake.archive = [];
  fake.pageSize = 2;
  fake.pageRequests = [];
});
afterAll(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.tracearrInstance.deleteMany();
  await cleanDatabase();
  await disconnectTestDb();
});

describe("a recovered play newer than every stored one", () => {
  it("leaves the next forward pass starting below the plays it has not read", async () => {
    const { server, t0, readded } = await setup();

    const recovery = await recoverHistoryForNewItems(server.id);
    expect(recovery).toEqual({ checked: 1, imported: 1 });
    expect(
      await prisma.watchHistory.count({ where: { mediaItemId: readded, sourceEventId: "chain-recovered" } }),
    ).toBe(1);

    await syncTracearrHistory(server.id, { passes: "forward" });

    const rows = await prisma.watchHistory.findMany({
      where: { mediaServerId: server.id },
      select: { sourceEventId: true },
      orderBy: { watchedAt: "desc" },
    });
    expect(rows.map((row) => row.sourceEventId)).toEqual([
      "chain-recovered",
      "chain-unread",
      "chain-stored",
    ]);
    // From the watermark the stored plays gave before recovery, not from the
    // recovered play.
    expect(fake.pageRequests[0].since).toEqual(new Date(t0.getTime() - HOUR));
  });

  it("records the old watermark before the play lands, and the forward walk that reads past it clears it", async () => {
    const { server, t0 } = await setup();

    await recoverHistoryForNewItems(server.id);
    expect((await readServer(server.id)).tracearrForwardResumeAt).toEqual(
      new Date(t0.getTime() - HOUR),
    );

    await syncTracearrHistory(server.id, { passes: "forward" });
    expect((await readServer(server.id)).tracearrForwardResumeAt).toBeNull();
  });

  it("keeps an older recorded window rather than moving it later", async () => {
    const { server, t0 } = await setup();
    const older = new Date(t0.getTime() - 2 * DAY);
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrForwardResumeAt: older },
    });

    await recoverHistoryForNewItems(server.id);

    expect((await readServer(server.id)).tracearrForwardResumeAt).toEqual(older);
  });

  it("records nothing for a recovered play no newer than the newest stored one", async () => {
    // The steady state: recovery brings back OLD plays, which leave the
    // forward watermark where it was.
    const { server, t0 } = await setup();
    fake.archive[0] = play("chain-recovered", "rk-readded", new Date(t0.getTime() - 20 * DAY));

    await expect(recoverHistoryForNewItems(server.id)).resolves.toEqual({ checked: 1, imported: 1 });

    expect((await readServer(server.id)).tracearrForwardResumeAt).toBeNull();
  });
});
