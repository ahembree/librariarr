import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
} from "../../setup/test-helpers";
import type { TracearrHistoryRecord } from "@/lib/tracearr/tracearr-client";

/**
 * The re-added-item recovery pass against a REAL database: the candidate SQL,
 * the shared join index and the upsert. The unit test mocks `$queryRawUnsafe`,
 * so only this file proves which rows the candidate query actually returns.
 *
 * Only Tracearr itself is faked.
 */

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));

const tracearr = vi.hoisted(() => ({
  getHistoryForItem: vi.fn(),
  getServerAccountNames: vi.fn(),
  listServers: vi.fn(),
}));
vi.mock("@/lib/tracearr/tracearr-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tracearr/tracearr-client")>();
  return {
    ...actual,
    // Constructor mock — must be a `function`, not an arrow (Vitest 4).
    TracearrClient: function (this: Record<string, unknown>) {
      this.getHistoryForItem = tracearr.getHistoryForItem;
      this.getServerAccountNames = tracearr.getServerAccountNames;
      this.listServers = tracearr.listServers;
    },
  };
});

import {
  recoverHistoryForNewItems,
  resetRecoveryAnswers,
} from "@/lib/sync/tracearr-backfill-additions";

const TRACEARR_SERVER_ID = "3f6f0d1e-0000-4000-8000-0000000000aa";
const DAY_MS = 24 * 60 * 60 * 1000;

function record(overrides: Partial<TracearrHistoryRecord>): TracearrHistoryRecord {
  const id = overrides.id ?? "chain";
  return {
    id,
    server_id: TRACEARR_SERVER_ID,
    server_name: "Plex",
    server_type: "plex",
    state: "stopped",
    media_type: "movie",
    media_title: "The Matrix",
    show_title: null,
    season_number: null,
    episode_number: null,
    year: 1999,
    artist_name: null,
    album_name: null,
    track_number: null,
    disc_number: null,
    thumb_path: null,
    poster_url: null,
    duration_ms: 8_100_000,
    progress_ms: 8_100_000,
    total_duration_ms: 8_160_000,
    percent_complete: 99.3,
    started_at: "2024-03-01T20:00:00.000Z",
    stopped_at: "2024-03-01T22:15:00.000Z",
    watched: true,
    segment_count: 1,
    device: null,
    player: null,
    product: null,
    platform: null,
    is_transcode: false,
    video_decision: null,
    audio_decision: null,
    bitrate: null,
    source_video_codec: null,
    source_audio_codec: null,
    source_audio_channels: null,
    source_video_width: null,
    source_video_height: null,
    source_video_details: null,
    source_audio_details: null,
    stream_video_codec: null,
    stream_audio_codec: null,
    stream_video_details: null,
    stream_audio_details: null,
    transcode_info: null,
    subtitle_info: null,
    resolution: null,
    source_video_codec_display: null,
    source_audio_codec_display: null,
    audio_channels_display: null,
    stream_video_codec_display: null,
    stream_audio_codec_display: null,
    media_id: null,
    show_media_id: null,
    imdb_id: null,
    tmdb_id: 603,
    tvdb_id: null,
    rating_key: "500",
    parent_rating_key: null,
    grandparent_rating_key: null,
    library_id: null,
    genres: null,
    reference_id: id,
    user: {
      id: "identity-1",
      server_user_id: "1",
      username: "Bob the identity",
      thumb_url: null,
      avatar_url: null,
    },
    ...overrides,
  };
}

describe("recoverHistoryForNewItems (real database)", () => {
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
    resetRecoveryAnswers();
    tracearr.getServerAccountNames.mockResolvedValue(new Map([["1", "bob"]]));
    tracearr.getHistoryForItem.mockResolvedValue([]);
    // The instance resolver asks which servers an instance monitors.
    tracearr.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID, name: "Plex" }]);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  /** A mapped server whose archive walk has finished — when recovery runs. */
  async function seedServer() {
    const user = await createTestUser();
    const server = await createTestServer(user.id, {
      tracearrServerId: TRACEARR_SERVER_ID,
      tracearrBackfillComplete: true,
    });
    // The one enabled instance, which (per `listServers`) monitors the mapping.
    await prisma.tracearrInstance.create({
      data: { userId: user.id, name: "Tracearr", url: "http://tracearr.test", apiKey: "key" },
    });
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    return { user, server, library };
  }

  it("recovers a re-added film's old plays even though its new play is already imported", async () => {
    const { server, library } = await seedServer();

    // Re-added two days ago under a NEW rating key, played once since — that
    // one play is already stored, which is what used to drop it from the
    // candidates and leave every older play unrecovered.
    const film = await createTestMediaItem(library.id, {
      ratingKey: "500",
      title: "The Matrix",
      year: 1999,
      playCount: 0,
    });
    await prisma.mediaItem.update({
      where: { id: film.id },
      data: { createdAt: new Date(Date.now() - 2 * DAY_MS) },
    });
    await createTestExternalId(film.id, "TMDB", "603");
    const newPlayAt = new Date(Date.now() - DAY_MS);
    await prisma.watchHistory.create({
      data: {
        mediaItemId: film.id,
        mediaServerId: server.id,
        serverUsername: "bob",
        watchedAt: newPlayAt,
        source: "TRACEARR",
        sourceEventId: "new-play",
        watched: false,
        percentComplete: 8,
      },
    });

    // Long in the library: the archive walk already had its chance at it.
    const backCatalogue = await createTestMediaItem(library.id, {
      ratingKey: "600",
      title: "Old Film",
    });
    await prisma.mediaItem.update({
      where: { id: backCatalogue.id },
      data: { createdAt: new Date(Date.now() - 30 * DAY_MS) },
    });

    const newPlay = record({
      id: "new-play",
      rating_key: "500",
      started_at: newPlayAt.toISOString(),
      stopped_at: newPlayAt.toISOString(),
      watched: false,
      percent_complete: 8,
    });
    tracearr.getHistoryForItem.mockImplementation(
      async (_server: string, filter: { ratingKey?: string; tmdbId?: string | null }) => {
        if (filter.ratingKey === "500") return [newPlay];
        if (filter.tmdbId === "603") {
          return [
            newPlay,
            // Filed under the rating key the film had before it left.
            record({ id: "old-1", rating_key: "123", started_at: "2024-03-01T20:00:00.000Z" }),
            record({ id: "old-2", rating_key: "123", started_at: "2025-01-10T20:00:00.000Z" }),
          ];
        }
        return [];
      },
    );

    const result = await recoverHistoryForNewItems(server.id);

    expect(result.checked).toBe(1);
    // Only the recent addition was a candidate.
    const asked = tracearr.getHistoryForItem.mock.calls.map((c) => c[1]);
    expect(asked).toEqual([{ ratingKey: "500" }, { tmdbId: "603", imdbId: null }]);

    const rows = await prisma.watchHistory.findMany({
      where: { mediaItemId: film.id },
      orderBy: { watchedAt: "asc" },
      select: { sourceEventId: true, serverUsername: true },
    });
    // The new play once (merged, not duplicated) plus both old ones, under the
    // media server's own account name.
    expect(rows.map((r) => r.sourceEventId)).toEqual(["old-1", "old-2", "new-play"]);
    expect(rows.every((r) => r.serverUsername === "bob")).toBe(true);

    // The point of the pass: the film no longer reads as never watched.
    const reconciled = await prisma.mediaItem.findUniqueOrThrow({ where: { id: film.id } });
    expect(reconciled.playCount).toBe(2);
    expect(reconciled.lastPlayedAt?.toISOString()).toBe("2025-01-10T20:00:00.000Z");
  });

  it("asks about each recent item once, then leaves it out of the candidate query", async () => {
    const { server, library } = await seedServer();
    await createTestMediaItem(library.id, { ratingKey: "701" });
    await createTestMediaItem(library.id, { ratingKey: "702" });

    await recoverHistoryForNewItems(server.id);
    expect(tracearr.getHistoryForItem.mock.calls.map((c) => c[1].ratingKey).sort()).toEqual([
      "701",
      "702",
    ]);

    tracearr.getHistoryForItem.mockClear();
    const result = await recoverHistoryForNewItems(server.id);

    // Both answered ("no plays"), so the query returns nothing and the pass
    // costs no request at all.
    expect(result).toEqual({ checked: 0, imported: 0 });
    expect(tracearr.getHistoryForItem).not.toHaveBeenCalled();
  });

  it("only offers items on the server being recovered, newest first, within the cap", async () => {
    const { user, server, library } = await seedServer();
    const other = await createTestServer(user.id, { name: "Other" });
    const otherLibrary = await createTestLibrary(other.id);
    await createTestMediaItem(otherLibrary.id, { ratingKey: "900" });

    for (const [key, ageDays] of [["801", 3], ["802", 1], ["803", 2]] as const) {
      const item = await createTestMediaItem(library.id, { ratingKey: key });
      await prisma.mediaItem.update({
        where: { id: item.id },
        data: { createdAt: new Date(Date.now() - ageDays * DAY_MS) },
      });
    }

    await recoverHistoryForNewItems(server.id, { limit: 2 });

    expect(tracearr.getHistoryForItem.mock.calls.map((c) => c[1].ratingKey)).toEqual([
      "802",
      "803",
    ]);
  });
});
