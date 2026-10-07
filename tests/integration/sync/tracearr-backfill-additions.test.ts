import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
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
  RECOVERY_REASK_MS,
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

  afterEach(() => {
    vi.useRealTimers();
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

  /** Backdate an item's row creation — the instant the pre-creation filter keys on. */
  async function createdDaysAgo(itemId: string, days: number) {
    await prisma.mediaItem.update({
      where: { id: itemId },
      data: { createdAt: new Date(Date.now() - days * DAY_MS) },
    });
  }

  async function storedPlay(itemId: string, serverId: string, watchedAt: Date, eventId: string, source = "TRACEARR") {
    await prisma.watchHistory.create({
      data: {
        mediaItemId: itemId,
        mediaServerId: serverId,
        serverUsername: "bob",
        watchedAt,
        source,
        sourceEventId: source === "TRACEARR" ? eventId : null,
      },
    });
  }

  function askedRatingKeys(): string[] {
    return tracearr.getHistoryForItem.mock.calls
      .map((c) => (c[1] as { ratingKey?: string }).ratingKey)
      .filter((key): key is string => key !== undefined)
      .sort();
  }

  it("does not offer an item whose plays from before its creation are already stored", async () => {
    const { server, library } = await seedServer();

    // Imported by the archive walk: a play older than the row itself.
    const walked = await createTestMediaItem(library.id, { ratingKey: "1001" });
    await createdDaysAgo(walked.id, 2);
    await storedPlay(walked.id, server.id, new Date(Date.now() - 400 * DAY_MS), "walked-old");

    // Re-added: its only stored play is one since it came back.
    const readded = await createTestMediaItem(library.id, { ratingKey: "1002" });
    await createdDaysAgo(readded.id, 2);
    await storedPlay(readded.id, server.id, new Date(Date.now() - DAY_MS), "readded-new");

    // A native row says nothing about what Tracearr was asked.
    const nativeOnly = await createTestMediaItem(library.id, { ratingKey: "1003" });
    await createdDaysAgo(nativeOnly.id, 2);
    await storedPlay(nativeOnly.id, server.id, new Date(Date.now() - 400 * DAY_MS), "n", "NATIVE");

    await recoverHistoryForNewItems(server.id);

    expect(askedRatingKeys()).toEqual(["1002", "1003"]);
  });

  it("offers a freshly synced library only its items that hold no walked history", async () => {
    // A new install (or a purge and resync): every item was created minutes
    // ago, so the window alone admits the whole library. The archive walk has
    // already stored the plays of everything ever watched — dated before the
    // rows existed — and none of those items may cost a request again,
    // including after a restart empties the in-memory registry.
    const { server, library } = await seedServer();
    for (let n = 0; n < 6; n++) {
      const item = await createTestMediaItem(library.id, { ratingKey: `${2000 + n}` });
      if (n % 2 === 0) {
        await storedPlay(item.id, server.id, new Date(Date.now() - (30 + n) * DAY_MS), `walk-${n}`);
      }
    }

    await recoverHistoryForNewItems(server.id);
    expect(askedRatingKeys()).toEqual(["2001", "2003", "2005"]);

    // Restart: the registry is gone, the rows are not.
    resetRecoveryAnswers();
    tracearr.getHistoryForItem.mockClear();
    await recoverHistoryForNewItems(server.id);
    expect(askedRatingKeys()).toEqual(["2001", "2003", "2005"]);
  });

  it("asks about nothing once the slice's deadline has passed, and stops mid-pass when it does", async () => {
    const { server, library } = await seedServer();
    for (const key of ["3001", "3002", "3003"]) {
      await createTestMediaItem(library.id, { ratingKey: key });
    }

    expect(await recoverHistoryForNewItems(server.id, { deadlineMs: Date.now() - 1 })).toEqual({
      checked: 0,
      imported: 0,
    });
    expect(tracearr.getHistoryForItem).not.toHaveBeenCalled();
    expect(tracearr.listServers).not.toHaveBeenCalled();

    let asked = 0;
    tracearr.getHistoryForItem.mockImplementation(async () => {
      asked++;
      return [];
    });
    const result = await recoverHistoryForNewItems(server.id, { yieldTo: () => asked >= 1 });
    expect(result.checked).toBe(1);

    // The two it never reached are still candidates.
    tracearr.getHistoryForItem.mockClear();
    tracearr.getHistoryForItem.mockResolvedValue([]);
    await recoverHistoryForNewItems(server.id);
    expect(askedRatingKeys()).toHaveLength(2);
  });

  it("keeps a re-added film a candidate while its old plays land on the old copy, and recovers them once that copy is gone", async () => {
    const { server, library } = await seedServer();

    // The old copy has not been purged yet; its rating key still claims the
    // film's old plays.
    const oldCopy = await createTestMediaItem(library.id, { ratingKey: "123", title: "The Matrix", year: 1999 });
    await createdDaysAgo(oldCopy.id, 400);
    await createTestExternalId(oldCopy.id, "TMDB", "603");
    const film = await createTestMediaItem(library.id, { ratingKey: "500", title: "The Matrix", year: 1999 });
    await createdDaysAgo(film.id, 2);
    await createTestExternalId(film.id, "TMDB", "603");

    const oldPlays = [
      record({ id: "old-1", rating_key: "123", started_at: "2024-03-01T20:00:00.000Z" }),
      record({ id: "old-2", rating_key: "123", started_at: "2025-01-10T20:00:00.000Z" }),
    ];
    tracearr.getHistoryForItem.mockImplementation(
      async (_server: string, filter: { ratingKey?: string; tmdbId?: string | null }) =>
        filter.tmdbId === "603" ? oldPlays : [],
    );

    const first = await recoverHistoryForNewItems(server.id);
    expect(first.imported).toBe(2);
    expect(await prisma.watchHistory.count({ where: { mediaItemId: oldCopy.id } })).toBe(2);
    expect(await prisma.watchHistory.count({ where: { mediaItemId: film.id } })).toBe(0);

    // Deferred, not settled — but not asked again on the very next pass.
    tracearr.getHistoryForItem.mockClear();
    expect(await recoverHistoryForNewItems(server.id)).toEqual({ checked: 0, imported: 0 });
    expect(tracearr.getHistoryForItem).not.toHaveBeenCalled();

    // The old copy is purged (the next day's full sync), and its plays
    // cascade with it.
    await prisma.mediaItem.delete({ where: { id: oldCopy.id } });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + RECOVERY_REASK_MS });

    // Re-asked: the same plays now resolve to the film by provider id.
    const second = await recoverHistoryForNewItems(server.id);
    expect(second).toEqual({ checked: 1, imported: 2 });
    const rows = await prisma.watchHistory.findMany({
      where: { mediaItemId: film.id },
      orderBy: { watchedAt: "asc" },
      select: { sourceEventId: true },
    });
    expect(rows.map((r) => r.sourceEventId)).toEqual(["old-1", "old-2"]);

    // Answered now — and, from the rows, still after a restart.
    resetRecoveryAnswers();
    tracearr.getHistoryForItem.mockClear();
    expect(await recoverHistoryForNewItems(server.id)).toEqual({ checked: 0, imported: 0 });
    expect(tracearr.getHistoryForItem).not.toHaveBeenCalled();
  });

  it("offers a re-added item whose only stored play landed before its row was created", async () => {
    // The film came back to the server, was played, and only THEN did our
    // sync create its row — so its one new play is dated before `createdAt`.
    // Keyed on `createdAt` itself, that play ended its candidacy and the
    // pre-delete plays were never asked for.
    const { server, library } = await seedServer();
    const film = await createTestMediaItem(library.id, { ratingKey: "500", title: "The Matrix", year: 1999 });
    await prisma.mediaItem.update({
      where: { id: film.id },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    await createTestExternalId(film.id, "TMDB", "603");
    const newPlayAt = new Date(Date.now() - 5 * 60 * 60 * 1000);
    await storedPlay(film.id, server.id, newPlayAt, "new-play");

    tracearr.getHistoryForItem.mockImplementation(
      async (_server: string, filter: { ratingKey?: string; tmdbId?: string | null }) =>
        filter.tmdbId === "603"
          ? [
              record({ id: "new-play", rating_key: "500", started_at: newPlayAt.toISOString() }),
              record({ id: "old-1", rating_key: "123", started_at: "2025-01-10T20:00:00.000Z" }),
            ]
          : [],
    );

    const result = await recoverHistoryForNewItems(server.id);

    expect(result).toEqual({ checked: 1, imported: 1 });
    expect(
      await prisma.watchHistory.count({ where: { mediaItemId: film.id, sourceEventId: "old-1" } }),
    ).toBe(1);
  });

  it("offers an item whose only plays are from the week before its row, once per run of the registry", async () => {
    // A new install whose library was watched in the days before it: nothing
    // tells those plays apart from a re-added item's new ones, so the item is
    // asked about — once, and again only after a restart empties the registry.
    const { server, library } = await seedServer();
    const item = await createTestMediaItem(library.id, { ratingKey: "4001" });
    await storedPlay(item.id, server.id, new Date(Date.now() - 3 * DAY_MS), "recent");

    await recoverHistoryForNewItems(server.id);
    expect(askedRatingKeys()).toEqual(["4001"]);

    tracearr.getHistoryForItem.mockClear();
    await recoverHistoryForNewItems(server.id);
    expect(tracearr.getHistoryForItem).not.toHaveBeenCalled();

    resetRecoveryAnswers();
    await recoverHistoryForNewItems(server.id);
    expect(askedRatingKeys()).toEqual(["4001"]);
  });

  describe("second copies whose plays always resolve to the other copy", () => {
    /**
     * `count` second copies (newest), each beside an older copy of the same
     * film that keeps claiming its plays — a 4K beside a 1080p — plus one
     * re-added film, older than all of them, whose old plays only a provider
     * id reaches.
     */
    async function seedCopiesAndReadd(count: number) {
      const { server, library } = await seedServer();
      for (let n = 0; n < count; n++) {
        const tmdb = String(1000 + n);
        const older = await createTestMediaItem(library.id, { ratingKey: `old-${n}`, title: `Film ${n}` });
        await createdDaysAgo(older.id, 400);
        await createTestExternalId(older.id, "TMDB", tmdb);
        const copy = await createTestMediaItem(library.id, { ratingKey: `copy-${n}`, title: `Film ${n}` });
        await prisma.mediaItem.update({
          where: { id: copy.id },
          data: { createdAt: new Date(Date.now() - (n + 1) * 60 * 60 * 1000) },
        });
        await createTestExternalId(copy.id, "TMDB", tmdb);
      }
      const readded = await createTestMediaItem(library.id, { ratingKey: "readded", title: "The Matrix" });
      await createdDaysAgo(readded.id, 3);
      await createTestExternalId(readded.id, "TMDB", "603");

      tracearr.getHistoryForItem.mockImplementation(
        async (_server: string, filter: { ratingKey?: string; tmdbId?: string | null }) => {
          if (filter.tmdbId === "603") {
            return [record({ id: "matrix-old", rating_key: "gone", started_at: "2025-01-10T20:00:00.000Z" })];
          }
          const n = Number(filter.tmdbId) - 1000;
          if (filter.tmdbId && n >= 0 && n < count) {
            return [
              record({
                id: `play-${n}`,
                rating_key: `old-${n}`,
                tmdb_id: 1000 + n,
                media_title: `Film ${n}`,
                started_at: "2024-05-01T20:00:00.000Z",
              }),
            ];
          }
          return [];
        },
      );
      return { server, readded };
    }

    function askedThisPass(): string[] {
      return tracearr.getHistoryForItem.mock.calls
        .map((c) => (c[1] as { ratingKey?: string }).ratingKey)
        .filter((key): key is string => key !== undefined);
    }

    it("cannot starve a re-added item below more than a cap's worth of them", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      const { server, readded } = await seedCopiesAndReadd(4);

      // Pass 1: the cap's three newest copies, deferred.
      await recoverHistoryForNewItems(server.id, { limit: 3 });
      expect(askedThisPass()).toEqual(["copy-0", "copy-1", "copy-2"]);

      // A day later all three are due again — and still come after every
      // item never asked. Re-asked on every pass ahead of it, as before, they
      // filled the cap for the whole window and the re-added film aged out
      // reading as never watched.
      vi.setSystemTime(new Date(Date.now() + RECOVERY_REASK_MS));
      tracearr.getHistoryForItem.mockClear();
      const second = await recoverHistoryForNewItems(server.id, { limit: 3 });
      expect(askedThisPass()).toEqual(["copy-3", "readded", "copy-0"]);
      // copy-3's play (onto its older copy) and the re-added film's old one.
      expect(second.imported).toBe(2);
      // The copies' plays stay on the copy that owns them.
      expect(
        await prisma.watchHistory.count({ where: { mediaItem: { ratingKey: { startsWith: "copy-" } } } }),
      ).toBe(0);
      expect(
        await prisma.watchHistory.count({ where: { mediaItemId: readded.id, sourceEventId: "matrix-old" } }),
      ).toBe(1);
    });

    it("reaches the re-added item within a pass of a restart emptying the registry", async () => {
      const { server, readded } = await seedCopiesAndReadd(4);
      await recoverHistoryForNewItems(server.id, { limit: 3 });

      // Restart: every copy is never-asked again. One pass re-asks the newest
      // three; their answers are recorded again, so the next pass gets past them.
      resetRecoveryAnswers();
      tracearr.getHistoryForItem.mockClear();
      await recoverHistoryForNewItems(server.id, { limit: 3 });
      expect(askedThisPass()).toEqual(["copy-0", "copy-1", "copy-2"]);

      tracearr.getHistoryForItem.mockClear();
      await recoverHistoryForNewItems(server.id, { limit: 3 });
      expect(askedThisPass()).toEqual(["copy-3", "readded"]);
      expect(await prisma.watchHistory.count({ where: { mediaItemId: readded.id } })).toBe(1);
    });
  });

  it("reports nothing imported when every record it got back was already stored", async () => {
    const { server, library } = await seedServer();
    const film = await createTestMediaItem(library.id, { ratingKey: "500", title: "The Matrix", year: 1999 });
    await createdDaysAgo(film.id, 2);
    // Since the re-add, so it does not end candidacy on its own.
    const playedAt = new Date(Date.now() - DAY_MS);
    await storedPlay(film.id, server.id, playedAt, "new-play");
    tracearr.getHistoryForItem.mockResolvedValue([
      record({ id: "new-play", rating_key: "500", started_at: playedAt.toISOString() }),
    ]);

    // Merged, not inserted: no reconcile, no cache drop, no event for the caller.
    expect(await recoverHistoryForNewItems(server.id)).toEqual({ checked: 1, imported: 0 });
    expect(await prisma.watchHistory.count({ where: { mediaItemId: film.id } })).toBe(1);
  });
});
