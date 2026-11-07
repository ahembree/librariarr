/**
 * An interrupted forward (catch-up) pass is resumed, not skipped.
 *
 * Tracearr serves history newest first, so a forward walk that stops after one
 * page has stored the newest plays of its window and not the older ones. The
 * next window used to start an hour before the newest stored play — above the
 * stretch the stopped walk never reached — so those plays were never asked for
 * again. Runs the real importer against the real database, with a fake archive
 * that honours `since`/`until` and pages by cursor.
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

const T = "11111111-2222-3333-4444-555555555555";

const fake = vi.hoisted(() => ({
  /** Every play Tracearr holds for the server, newest first. */
  archive: [] as TracearrHistoryRecord[],
  pageSize: 2,
  /** A cursor whose page request fails, as a connection reset would. */
  failCursor: null as string | null,
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
      if (opts.cursor && opts.cursor === fake.failCursor) throw new Error("read ECONNRESET");
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
 * A server whose archive is fully walked, holding one play from three days ago
 * — so the forward window starts an hour before it.
 */
async function setup(options: { watchHistorySyncedAt?: Date | null } = {}) {
  const user = await createTestUser();
  await prisma.tracearrInstance.create({ data: { userId: user.id, name: "T", url: "http://t", apiKey: "k" } });
  const server = await createTestServer(user.id, {
    type: "PLEX",
    tracearrServerId: T,
    tracearrBackfillComplete: true,
    ...(options.watchHistorySyncedAt !== undefined
      ? { watchHistorySyncedAt: options.watchHistorySyncedAt }
      : {}),
  });
  const lib = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
  const items = new Map<string, string>();
  for (const key of ["rk-stored", "rk-gap", "rk-new-1", "rk-new-2"]) {
    const item = await createTestMediaItem(lib.id, { ratingKey: key, title: key });
    items.set(key, item.id);
  }
  const storedAt = new Date(Date.now() - 3 * DAY);
  await prisma.watchHistory.create({
    data: {
      mediaItemId: items.get("rk-stored")!,
      mediaServerId: server.id,
      serverUsername: "weingart",
      watchedAt: storedAt,
      source: "TRACEARR",
      sourceEventId: "chain-stored",
      watched: true,
      state: "stopped",
    },
  });
  return { server, items, storedAt };
}

const readServer = (id: string) => prisma.mediaServer.findUniqueOrThrow({ where: { id } });
const storedChains = async (serverId: string) =>
  (
    await prisma.watchHistory.findMany({
      where: { mediaServerId: serverId, source: "TRACEARR" },
      select: { sourceEventId: true },
      orderBy: { watchedAt: "desc" },
    })
  ).map((row) => row.sourceEventId);

beforeEach(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.tracearrInstance.deleteMany();
  await cleanDatabase();
  fake.archive = [];
  fake.pageSize = 2;
  fake.failCursor = null;
  fake.requests = [];
});
afterAll(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.tracearrInstance.deleteMany();
  await cleanDatabase();
  await disconnectTestDb();
});

describe("a forward pass interrupted after its first page", () => {
  it("is resumed by the next run, and the plays it never reached land", async () => {
    const { server, storedAt } = await setup();
    const now = Date.now();
    // Newest first: two new plays fill page 1, and the play from two days ago
    // — between the stored one and page 1 — is on page 2.
    fake.archive = [
      play("chain-new-1", "rk-new-1", new Date(now - HOUR)),
      play("chain-new-2", "rk-new-2", new Date(now - 2 * HOUR)),
      play("chain-gap", "rk-gap", new Date(now - 2 * DAY)),
      play("chain-stored", "rk-stored", storedAt),
    ];
    const windowStart = new Date(storedAt.getTime() - HOUR);

    // Run 1: page 2 never arrives.
    fake.failCursor = "2";
    await syncTracearrHistory(server.id, { passes: "forward" });

    expect(fake.requests[0].since).toEqual(windowStart);
    expect(await storedChains(server.id)).toEqual(["chain-new-1", "chain-new-2", "chain-stored"]);
    const recordedAfterRun1 = (await readServer(server.id)).tracearrForwardResumeAt;

    // Run 2: Tracearr answers again.
    fake.failCursor = null;
    fake.requests = [];
    await syncTracearrHistory(server.id, { passes: "forward" });

    // The play run 1 never reached has landed...
    expect(await storedChains(server.id)).toEqual([
      "chain-new-1",
      "chain-new-2",
      "chain-gap",
      "chain-stored",
    ]);
    // ...because run 2 asked from where run 1's window started, not from an
    // hour before the newest play run 1 stored (which starts above the gap).
    expect(fake.requests[0].since).toEqual(windowStart);
    // Run 1 left that start on record; run 2 walked to its end and closed it.
    expect(recordedAfterRun1).toEqual(windowStart);
    expect((await readServer(server.id)).tracearrForwardResumeAt).toBeNull();

    // And the run after that is an ordinary catch-up again.
    fake.requests = [];
    await syncTracearrHistory(server.id, { passes: "forward" });
    expect(fake.requests[0].since).toEqual(new Date(now - HOUR - HOUR));
  });

  it("does not establish the play history while that window is open", async () => {
    // A run that leaves plays unread below the ones it stored has not
    // established what was played here.
    const { server, storedAt } = await setup({ watchHistorySyncedAt: null });
    const now = Date.now();
    fake.archive = [
      play("chain-new-1", "rk-new-1", new Date(now - HOUR)),
      play("chain-new-2", "rk-new-2", new Date(now - 2 * HOUR)),
      play("chain-gap", "rk-gap", new Date(now - 2 * DAY)),
      play("chain-stored", "rk-stored", storedAt),
    ];

    fake.failCursor = "2";
    await syncTracearrHistory(server.id, { passes: "forward" });
    expect((await readServer(server.id)).watchHistorySyncedAt).toBeNull();

    fake.failCursor = null;
    await syncTracearrHistory(server.id, { passes: "forward" });
    expect((await readServer(server.id)).watchHistorySyncedAt).toBeInstanceOf(Date);
  });

  it("records nothing for a forward window that fits in one page", async () => {
    const { server, storedAt } = await setup();
    fake.pageSize = 100;
    fake.archive = [
      play("chain-new-1", "rk-new-1", new Date(Date.now() - HOUR)),
      play("chain-stored", "rk-stored", storedAt),
    ];

    await syncTracearrHistory(server.id, { passes: "forward" });

    const after = await readServer(server.id);
    expect(after.tracearrForwardResumeAt).toBeNull();
    expect(await storedChains(server.id)).toEqual(["chain-new-1", "chain-stored"]);
  });
});
