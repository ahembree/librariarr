import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanDatabase,
  disconnectTestDb,
  getTestPrisma,
} from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import route handler AFTER mocks
import { GET } from "@/app/api/media/series/watch-history/route";

/**
 * The Tracearr half of the row shape. Every field is nullable and every one is
 * null on a NATIVE row — the card keys its rich secondary line off exactly
 * that, so the route must return them rather than omit them.
 */
interface HistoryRow {
  id: string;
  serverUsername: string;
  watchedAt: string | null;
  deviceName: string | null;
  platform: string | null;
  source: string;
  sourceEventId: string | null;
  referenceId: string | null;
  watched: boolean | null;
  percentComplete: number | null;
  state: string | null;
  progressMs: number | null;
  durationMs: number | null;
  totalDurationMs: number | null;
  segmentCount: number | null;
  stoppedAt: string | null;
  player: string | null;
  product: string | null;
  isTranscode: boolean | null;
  videoDecision: string | null;
  audioDecision: string | null;
  bitrate: number | null;
  resolution: string | null;
  sourceVideoCodec: string | null;
  sourceAudioCodec: string | null;
  streamVideoCodec: string | null;
  streamAudioCodec: string | null;
  transcodeInfo: unknown;
  subtitleInfo: unknown;
  streamQuality: unknown;
  mediaItem: {
    id: string;
    title: string;
    parentTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
  };
  server: { id: string; name: string; type: string };
}

interface HistoryResponse {
  items: HistoryRow[];
  pagination: { page: number; limit: number; hasMore: boolean; totalCount: number };
}

/** Tracearr's `transcode_info`, stored verbatim. */
const TRANSCODE_INFO = {
  containerDecision: "transcode",
  sourceContainer: "mkv",
  streamContainer: "mp4",
  hwRequested: true,
  hwDecoding: "nvdec",
  hwEncoding: "nvenc",
  speed: 3.4,
  throttled: true,
  reasons: ["Container not supported", "Audio codec not supported"],
};

/** Tracearr's `subtitle_info`, stored verbatim. */
const SUBTITLE_INFO = {
  decision: "burn",
  codec: "subrip",
  language: "English",
  forced: false,
};

/**
 * The bundled source_/stream_ detail objects and display strings. The importer
 * owns this shape, so the assertion is structural round-tripping (Postgres
 * jsonb in, same object out) rather than a field-by-field contract.
 */
const STREAM_QUALITY = {
  source_video_width: 3840,
  source_video_height: 2160,
  source_audio_channels: 6,
  source_video_codec_display: "HEVC",
  source_audio_codec_display: "TrueHD",
  audio_channels_display: "5.1",
  stream_video_codec_display: "H.264",
  stream_audio_codec_display: "AAC",
  source_video_details: {
    bitrate: 42000,
    framerate: "23.976",
    dynamicRange: "Dolby Vision",
    profile: "main 10",
  },
  source_audio_details: { bitrate: 4500, channelLayout: "5.1(side)", language: "English" },
  stream_video_details: { bitrate: 8000, width: 1920, height: 1080, dynamicRange: "SDR" },
  stream_audio_details: { bitrate: 256, channels: 2, language: "English" },
};

describe("GET /api/media/series/watch-history — Tracearr detail", () => {
  let userId: string;
  let serverId: string;
  let libraryId: string;

  /** A NATIVE row: what a media-server scan records, and nothing more. */
  async function addNativeWatch(mediaItemId: string, serverUsername = "alice") {
    return getTestPrisma().watchHistory.create({
      data: {
        mediaItemId,
        mediaServerId: serverId,
        serverUsername,
        watchedAt: new Date("2024-06-01T20:00:00Z"),
        deviceName: "Living Room TV",
        platform: "Roku",
      },
    });
  }

  /** A TRACEARR row: an imported play event, with the full stream detail. */
  async function addTracearrWatch(
    mediaItemId: string,
    overrides: Partial<{
      serverUsername: string;
      watchedAt: Date;
      sourceEventId: string;
      watched: boolean;
      percentComplete: number;
      segmentCount: number;
    }> = {},
  ) {
    const sourceEventId = overrides.sourceEventId ?? "chain-1";
    return getTestPrisma().watchHistory.create({
      data: {
        mediaItemId,
        mediaServerId: serverId,
        serverUsername: overrides.serverUsername ?? "bob",
        watchedAt: overrides.watchedAt ?? new Date("2024-07-04T18:30:00Z"),
        deviceName: "Apple TV",
        platform: "tvOS",
        source: "TRACEARR",
        sourceEventId,
        // Documented as the resume-chain key, and currently identical to the
        // event id — segmentCount is what actually reveals a resumed play.
        referenceId: sourceEventId,
        watched: overrides.watched ?? true,
        percentComplete: overrides.percentComplete ?? 96.4,
        state: "stopped",
        progressMs: 2_640_000,
        durationMs: 2_580_000,
        totalDurationMs: 2_700_000,
        segmentCount: overrides.segmentCount ?? 3,
        stoppedAt: new Date("2024-07-04T19:15:00Z"),
        player: "Apple TV",
        product: "Plex for Apple TV",
        isTranscode: true,
        videoDecision: "transcode",
        audioDecision: "copy",
        bitrate: 8000,
        resolution: "4K",
        sourceVideoCodec: "hevc",
        sourceAudioCodec: "truehd",
        streamVideoCodec: "h264",
        streamAudioCodec: "aac",
        transcodeInfo: TRANSCODE_INFO,
        subtitleInfo: SUBTITLE_INFO,
        streamQuality: STREAM_QUALITY,
      },
    });
  }

  /** Creates an episode row and returns its id. */
  async function makeEpisode(
    seasonNumber: number,
    episodeNumber: number,
    title: string,
  ): Promise<string> {
    const item = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title,
      parentTitle: "Adventure Time",
      seriesKey: "tvdb:152831",
      seasonNumber,
      episodeNumber,
    });
    return item.id;
  }

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true, plexToken: "token" });
    const server = await createTestServer(userId);
    serverId = server.id;
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    libraryId = library.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns every Tracearr column with its real value", async () => {
    const episode = await makeEpisode(1, 1, "Slumber Party Panic");
    await addTracearrWatch(episode);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { seriesKey: "tvdb:152831" },
      }),
    );

    expect(data.items).toHaveLength(1);
    const row = data.items[0];
    expect(row).toMatchObject({
      source: "TRACEARR",
      sourceEventId: "chain-1",
      referenceId: "chain-1",
      watched: true,
      percentComplete: 96.4,
      state: "stopped",
      progressMs: 2_640_000,
      durationMs: 2_580_000,
      totalDurationMs: 2_700_000,
      segmentCount: 3,
      player: "Apple TV",
      product: "Plex for Apple TV",
      isTranscode: true,
      videoDecision: "transcode",
      audioDecision: "copy",
      bitrate: 8000,
      resolution: "4K",
      sourceVideoCodec: "hevc",
      sourceAudioCodec: "truehd",
      streamVideoCodec: "h264",
      streamAudioCodec: "aac",
    });
    // Serialised the same way as watchedAt, not left as a Date.
    expect(row.stoppedAt).toBe("2024-07-04T19:15:00.000Z");
    expect(row.watchedAt).toBe("2024-07-04T18:30:00.000Z");
  });

  it("round-trips the three JSON columns structurally", async () => {
    // The card reads these objects structurally, so what matters is that the
    // stored shape survives jsonb + JSON serialisation unchanged — nested
    // objects, arrays, booleans and floats included.
    const episode = await makeEpisode(1, 1, "Slumber Party Panic");
    await addTracearrWatch(episode);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { seriesKey: "tvdb:152831" },
      }),
    );

    const row = data.items[0];
    expect(row.transcodeInfo).toEqual(TRANSCODE_INFO);
    expect(row.subtitleInfo).toEqual(SUBTITLE_INFO);
    expect(row.streamQuality).toEqual(STREAM_QUALITY);
  });

  it("returns every Tracearr column as null on a NATIVE row", async () => {
    // This is the acceptance bar for the card: a native row must carry no
    // Tracearr detail at all, so its secondary line renders nothing.
    const episode = await makeEpisode(1, 1, "Slumber Party Panic");
    await addNativeWatch(episode);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { seriesKey: "tvdb:152831" },
      }),
    );

    expect(data.items).toHaveLength(1);
    const row = data.items[0];
    // The pre-existing columns are untouched.
    expect(row).toMatchObject({
      source: "NATIVE",
      serverUsername: "alice",
      deviceName: "Living Room TV",
      platform: "Roku",
    });
    expect(row.watchedAt).toBe("2024-06-01T20:00:00.000Z");
    for (const field of [
      "sourceEventId",
      "referenceId",
      "watched",
      "percentComplete",
      "state",
      "progressMs",
      "durationMs",
      "totalDurationMs",
      "segmentCount",
      "stoppedAt",
      "player",
      "product",
      "isTranscode",
      "videoDecision",
      "audioDecision",
      "bitrate",
      "resolution",
      "sourceVideoCodec",
      "sourceAudioCodec",
      "streamVideoCodec",
      "streamAudioCodec",
      "transcodeInfo",
      "subtitleInfo",
      "streamQuality",
    ] as const) {
      expect(row[field], field).toBeNull();
    }
  });

  it("returns an unfinished play — a partial play is still a play", async () => {
    // Only the watch-state reconcile cares about the completion threshold; this
    // route is display data, and dropping watched=false would hide the plays a
    // household actually made from the history card.
    const episode = await makeEpisode(1, 1, "Slumber Party Panic");
    await addTracearrWatch(episode, {
      sourceEventId: "chain-partial",
      serverUsername: "carol",
      watched: false,
      percentComplete: 12.5,
    });

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { seriesKey: "tvdb:152831" },
      }),
    );

    expect(data.pagination.totalCount).toBe(1);
    expect(data.items[0]).toMatchObject({
      serverUsername: "carol",
      watched: false,
      percentComplete: 12.5,
    });
  });

  it("keeps NATIVE and TRACEARR rows in one newest-first list", async () => {
    const episode = await makeEpisode(1, 1, "Slumber Party Panic");
    await addNativeWatch(episode); // 2024-06-01
    await addTracearrWatch(episode, {
      sourceEventId: "chain-newest",
      watchedAt: new Date("2024-08-09T21:00:00Z"),
    });

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { seriesKey: "tvdb:152831" },
      }),
    );

    expect(data.pagination.totalCount).toBe(2);
    expect(data.items.map((i) => i.source)).toEqual(["TRACEARR", "NATIVE"]);
  });

  it("paginates the mixed list without duplicating or dropping rows", async () => {
    const episode = await makeEpisode(1, 1, "Slumber Party Panic");
    const tie = new Date("2024-06-01T20:00:00Z");
    await addNativeWatch(episode, "native-1");
    await addNativeWatch(episode, "native-2");
    for (let i = 0; i < 3; i++) {
      await addTracearrWatch(episode, {
        sourceEventId: `chain-${i}`,
        serverUsername: `tracearr-${i}`,
        watchedAt: tie,
      });
    }

    const pages = await Promise.all(
      [1, 2, 3].map(async (page) =>
        expectJson<HistoryResponse>(
          await callRoute(GET, {
            url: "/api/media/series/watch-history",
            searchParams: { seriesKey: "tvdb:152831", limit: "2", page: String(page) },
          }),
        ),
      ),
    );

    expect(pages[0].pagination.totalCount).toBe(5);
    expect(pages.map((p) => p.pagination.hasMore)).toEqual([true, true, false]);
    const ids = pages.flatMap((p) => p.items).map((i) => i.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });
});
