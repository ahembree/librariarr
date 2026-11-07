/**
 * An archive walk that legitimately stored nothing is not walked again — and
 * the server still catches up on new plays — while an archive whose rows were
 * wiped out from under the "complete" flag still restarts.
 *
 * A complete walk that saw records but could join none of them marks the
 * backfill complete. The next run used to read "complete with no rows" as
 * stale and reset it, so the whole archive was re-walked in slices, completed,
 * and reset again on every forward sync, with play-activity rules refused for
 * the server while each walk ran. Runs the real importer against the real
 * database, with a fake archive that honours `since`/`until` and pages by
 * cursor.
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

const T = "cccccccc-1111-2222-3333-444444444444";

const fake = vi.hoisted(() => ({
  /** Every play Tracearr holds for the server, newest first. */
  archive: [] as TracearrHistoryRecord[],
  pageSize: 2,
  requests: [] as Array<{ since?: Date; until?: Date; cursor?: string }>,
}));

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getServerAccountNames = async () => new Map([["u1", "weingart"]]);
    this.findOldestPlayAt = async () => null;
    this.listServers = async () => [{ id: T }];
    this.getHistoryPage = async (
      _id: string,
      opts: { since?: Date; until?: Date; cursor?: string },
    ) => {
      fake.requests.push({ since: opts.since, until: opts.until, cursor: opts.cursor });
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

import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import { checkWatchHistoryCompleteness } from "@/lib/lifecycle/evaluability";

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

/** Plays of media that is no longer in the library — none of them can be joined. */
function unjoinableArchive() {
  const now = Date.now();
  return [
    play("gone-1", "rk-gone-1", new Date(now - 10 * DAY)),
    play("gone-2", "rk-gone-2", new Date(now - 40 * DAY)),
    play("gone-3", "rk-gone-3", new Date(now - 400 * DAY)),
  ];
}

async function setup(state: {
  tracearrBackfillComplete?: boolean;
  watchHistorySyncedAt?: Date | null;
  tracearrForwardResumeAt?: Date | null;
} = {}) {
  const user = await createTestUser();
  await prisma.tracearrInstance.create({ data: { userId: user.id, name: "T", url: "http://t", apiKey: "k" } });
  // Freshly mapped: the mapping change withdrew the marker and reset the walk.
  const server = await createTestServer(user.id, {
    type: "PLEX",
    tracearrServerId: T,
    tracearrBackfillComplete: state.tracearrBackfillComplete ?? false,
    watchHistorySyncedAt: state.watchHistorySyncedAt ?? null,
  });
  if (state.tracearrForwardResumeAt !== undefined) {
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrForwardResumeAt: state.tracearrForwardResumeAt },
    });
  }
  const lib = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
  const item = await createTestMediaItem(lib.id, { ratingKey: "rk-here", title: "Still here" });
  return { user, server, item };
}

const readServer = (id: string) => prisma.mediaServer.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.tracearrInstance.deleteMany();
  await cleanDatabase();
  fake.archive = [];
  fake.pageSize = 2;
  fake.requests = [];
});
afterAll(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.tracearrInstance.deleteMany();
  await cleanDatabase();
  await disconnectTestDb();
});

describe("an archive walk that stored nothing", () => {
  it("is not walked again, and the server's play history stays established", async () => {
    const { user, server } = await setup();
    fake.archive = unjoinableArchive();

    // The walk: every page read, nothing joinable.
    await syncTracearrHistory(server.id, { passes: "backfill" });
    const walked = await readServer(server.id);
    expect(walked.tracearrBackfillComplete).toBe(true);
    expect(walked.watchHistorySyncedAt).toBeInstanceOf(Date);
    expect(await prisma.watchHistory.count({ where: { mediaServerId: server.id } })).toBe(0);

    // The backfill task queued after the next forward sync — a slice whose
    // budget lets it read one page, as a large archive's would.
    fake.requests = [];
    const result = await syncTracearrHistory(server.id, {
      passes: "backfill",
      deadlineMs: Date.now() - 1,
    });

    expect(fake.requests).toEqual([]);
    expect(result.backfillPending).toBe(false);
    const after = await readServer(server.id);
    expect(after.tracearrBackfillComplete).toBe(true);
    expect(after.tracearrBackfillCursorAt).toEqual(walked.tracearrBackfillCursorAt);
    // So play-activity rules are not refused for it.
    await expect(checkWatchHistoryCompleteness(user.id, [server.id])).resolves.toEqual({
      complete: true,
    });
  });

  it("still catches up on new plays, from where the walk began", async () => {
    const { server, item } = await setup();
    fake.archive = unjoinableArchive();
    const beforeWalk = Date.now();
    await syncTracearrHistory(server.id, { passes: "backfill" });
    const watermark = (await readServer(server.id)).tracearrForwardResumeAt!;
    // The walk read everything up to when it began; the forward pass takes
    // over from there, with the usual hour of overlap.
    expect(watermark.getTime()).toBeGreaterThanOrEqual(beforeWalk - HOUR);
    expect(watermark.getTime()).toBeLessThanOrEqual(Date.now() - HOUR);

    // Somebody watches something that IS in the library.
    fake.archive = [play("new-1", "rk-here", new Date(Date.now() - 5 * 60_000)), ...fake.archive];
    fake.requests = [];
    await syncTracearrHistory(server.id, { passes: "forward" });

    expect(fake.requests[0].since).toEqual(watermark);
    expect(
      await prisma.watchHistory.findMany({
        where: { mediaServerId: server.id },
        select: { sourceEventId: true, mediaItemId: true },
      }),
    ).toEqual([{ sourceEventId: "new-1", mediaItemId: item.id }]);
  });

  it("keeps the forward watermark moving while nothing joins", async () => {
    const { server } = await setup();
    fake.archive = unjoinableArchive();
    await syncTracearrHistory(server.id, { passes: "backfill" });
    const first = (await readServer(server.id)).tracearrForwardResumeAt!;

    fake.archive = [play("gone-new", "rk-gone-new", new Date(Date.now() - 60_000)), ...fake.archive];
    const beforeCatchUp = Date.now();
    await syncTracearrHistory(server.id, { passes: "forward" });

    const moved = (await readServer(server.id)).tracearrForwardResumeAt!;
    expect(moved.getTime()).toBeGreaterThanOrEqual(beforeCatchUp - HOUR);
    expect(moved.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });
});

describe("an archive whose rows were wiped out from under the flag", () => {
  it("restarts the walk from the newest play when the history was withdrawn", async () => {
    // A config-only restore: the server row comes back as it was ("complete",
    // with its watermark), its plays do not, and the restore withdraws the
    // established marker from every server left without plays.
    const { server } = await setup({
      tracearrBackfillComplete: true,
      watchHistorySyncedAt: null,
      tracearrForwardResumeAt: new Date(Date.now() - 3 * DAY),
    });
    fake.archive = [play("restored-1", "rk-here", new Date(Date.now() - 2 * DAY)), ...unjoinableArchive()];

    await syncTracearrHistory(server.id, { passes: "backfill" });

    // From the newest play, not from the stored cursor or watermark.
    expect(fake.requests[0]).toMatchObject({ until: undefined, since: undefined });
    expect(await prisma.watchHistory.count({ where: { mediaServerId: server.id } })).toBe(1);
    const after = await readServer(server.id);
    expect(after.tracearrBackfillComplete).toBe(true);
    // Rows exist again, so the old watermark is dropped with the reset.
    expect(after.tracearrForwardResumeAt).toBeNull();
  });

  it("walks once more when a completed walk left no watermark, then leaves it alone", async () => {
    // Completed with nothing stored by a version that recorded no forward
    // watermark: nothing to catch up from, so the archive is walked once more
    // to establish one — and only once.
    const { server } = await setup({
      tracearrBackfillComplete: true,
      watchHistorySyncedAt: new Date(),
      tracearrForwardResumeAt: null,
    });
    fake.archive = unjoinableArchive();

    await syncTracearrHistory(server.id, { passes: "backfill" });
    expect(fake.requests.length).toBeGreaterThan(0);
    expect((await readServer(server.id)).tracearrForwardResumeAt).toBeInstanceOf(Date);

    fake.requests = [];
    await syncTracearrHistory(server.id, { passes: "backfill" });
    expect(fake.requests).toEqual([]);
  });
});
