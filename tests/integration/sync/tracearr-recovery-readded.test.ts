/**
 * Recovery of a re-added item that was played again before recovery reached
 * it — the real candidate query and the real importer, against the real
 * database.
 *
 * A film is deleted (its plays cascade away), re-downloaded under a new rating
 * key, and watched again; the forward pass imports that new play. Recovery
 * used to skip any item holding a Tracearr play at all, and asked by provider
 * id only when the rating key found nothing — so the film's earlier plays and
 * earlier watchers never came back.
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

const T = "bbbbbbbb-1111-2222-3333-444444444444";

const fake = vi.hoisted(() => ({
  /** Every play Tracearr holds for the server. */
  plays: [] as TracearrHistoryRecord[],
  asked: [] as Array<{ ratingKey?: string; tmdbId?: string | number | null; imdbId?: string | null }>,
}));

vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getServerAccountNames = async () => new Map([["u1", "weingart"], ["u2", "alice"]]);
    this.listServers = async () => [{ id: T }];
    this.getHistoryForItem = async (
      _id: string,
      filter: { ratingKey?: string; tmdbId?: string | number | null; imdbId?: string | null },
    ) => {
      fake.asked.push(filter);
      if (filter.ratingKey) return fake.plays.filter((p) => p.rating_key === filter.ratingKey);
      if (filter.tmdbId != null) return fake.plays.filter((p) => String(p.tmdb_id) === String(filter.tmdbId));
      return [];
    };
  },
}));

import {
  recoverHistoryForNewItems,
  resetRecoveryAnswers,
} from "@/lib/sync/tracearr-backfill-additions";

const prisma = getTestPrisma();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function play(
  id: string,
  ratingKey: string,
  startedAt: Date,
  serverUserId: string,
  tmdbId: number | null = null,
): TracearrHistoryRecord {
  return {
    id,
    reference_id: id,
    server_id: T,
    state: "stopped",
    media_type: "movie",
    rating_key: ratingKey,
    grandparent_rating_key: null,
    parent_rating_key: null,
    tmdb_id: tmdbId,
    imdb_id: null,
    tvdb_id: null,
    started_at: startedAt.toISOString(),
    stopped_at: new Date(startedAt.getTime() + 2 * HOUR).toISOString(),
    watched: true,
    percent_complete: 100,
    segment_count: 1,
    user: { id: `identity-${serverUserId}`, server_user_id: serverUserId, username: "Tracearr Label" },
  } as unknown as TracearrHistoryRecord;
}

async function setup() {
  const user = await createTestUser();
  await prisma.tracearrInstance.create({ data: { userId: user.id, name: "T", url: "http://t", apiKey: "k" } });
  const server = await createTestServer(user.id, {
    type: "PLEX",
    tracearrServerId: T,
    tracearrBackfillComplete: true,
  });
  const lib = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
  return { server, lib };
}

async function addMovie(libraryId: string, ratingKey: string, tmdbId: string, addedAgo: number) {
  const item = await createTestMediaItem(libraryId, { ratingKey, title: ratingKey });
  await prisma.mediaItem.update({
    where: { id: item.id },
    data: { createdAt: new Date(Date.now() - addedAgo) },
  });
  await prisma.mediaItemExternalId.create({
    data: { mediaItemId: item.id, source: "TMDB", externalId: tmdbId },
  });
  return item;
}

async function storePlay(serverId: string, itemId: string, chain: string, watchedAt: Date) {
  await prisma.watchHistory.create({
    data: {
      mediaItemId: itemId,
      mediaServerId: serverId,
      serverUsername: "weingart",
      watchedAt,
      source: "TRACEARR",
      sourceEventId: chain,
      watched: true,
      state: "stopped",
    },
  });
}

beforeEach(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.tracearrInstance.deleteMany();
  await cleanDatabase();
  resetRecoveryAnswers();
  fake.plays = [];
  fake.asked = [];
});
afterAll(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.tracearrInstance.deleteMany();
  await cleanDatabase();
  await disconnectTestDb();
});

describe("recovering a re-added item that was played again first", () => {
  it("brings back its earlier plays and watchers through the provider id", async () => {
    const { server, lib } = await setup();
    // Re-added yesterday under a new rating key, and watched again since —
    // the forward pass has already imported that play.
    const film = await addMovie(lib.id, "rk-new", "603", DAY);
    const rewatch = new Date(Date.now() - 2 * HOUR);
    await storePlay(server.id, film.id, "chain-rewatch", rewatch);
    fake.plays = [
      play("chain-rewatch", "rk-new", rewatch, "u1", 603),
      // Under the rating key the film had before it was deleted.
      play("chain-first-watch", "rk-old", new Date(Date.now() - 60 * DAY), "u2", 603),
    ];

    await recoverHistoryForNewItems(server.id);

    const rows = await prisma.watchHistory.findMany({
      where: { mediaItemId: film.id },
      select: { sourceEventId: true, serverUsername: true },
      orderBy: { watchedAt: "asc" },
    });
    expect(rows).toEqual([
      { sourceEventId: "chain-first-watch", serverUsername: "alice" },
      { sourceEventId: "chain-rewatch", serverUsername: "weingart" },
    ]);
    expect(fake.asked).toEqual([{ ratingKey: "rk-new" }, { tmdbId: "603", imdbId: null }]);
  });

  it("does not ask about an item whose history from before it was added is already stored", async () => {
    const { server, lib } = await setup();
    // Created yesterday, but its plays from before then were found by the
    // archive walk — its history is already here.
    const film = await addMovie(lib.id, "rk-1", "550", DAY);
    await storePlay(server.id, film.id, "chain-old", new Date(Date.now() - 30 * DAY));

    const result = await recoverHistoryForNewItems(server.id);

    expect(result).toEqual({ checked: 0, imported: 0 });
    expect(fake.asked).toEqual([]);
  });
});
