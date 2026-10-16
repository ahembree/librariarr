import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestMediaStream,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET as mediaGET } from "@/app/api/media/distinct-values/route";
import { GET as queryGET } from "@/app/api/query/distinct-values/route";
import { appCache } from "@/lib/cache/memory-cache";

type Values = Record<string, unknown>;

/** Two items differing in every enumerable column, each with audio, subtitle and video streams. */
async function seedTwoOfEverything() {
  const user = await createTestUser();
  setMockSession({ userId: user.id, isLoggedIn: true });
  const server = await createTestServer(user.id);
  const lib = await createTestLibrary(server.id, { type: "MOVIE" });
  const prisma = getTestPrisma();
  const specs = [
    {
      title: "Zed", year: 1999, resolution: "720", videoCodec: "vp9", audioCodec: "opus", container: "webm",
      dynamicRange: "SDR", audioProfile: "Stereo", contentRating: "R", studio: "Zeta Films",
      genres: ["war"], labels: ["zlabel"], countries: ["Zambia"],
      raw: { videoBitDepth: 8, audioChannels: 6, videoProfile: "main", videoFrameRate: "24p", aspectRatio: "2.39", scanType: "progressive", audioSamplingRate: 48000 },
      audio: { language: "spanish", codec: "aac", profile: "lc", languageCode: "spa", audioChannelLayout: "stereo" },
      sub: { language: "French" },
      video: { codec: "vp9", profile: "main", scanType: "progressive", videoRangeType: "SDR", colorPrimaries: "bt709", colorRange: "tv", chromaSubsampling: "4:2:0" },
    },
    {
      title: "Alpha", year: 2021, resolution: "2160", videoCodec: "av1", audioCodec: "aac", container: "mkv",
      dynamicRange: "Dolby Vision", audioProfile: "Atmos", contentRating: "G", studio: "Alpha Studio",
      genres: ["Action"], labels: ["alabel"], countries: ["Austria"],
      raw: { videoBitDepth: 10, audioChannels: 2, videoProfile: "high", videoFrameRate: "60p", aspectRatio: "1.78", scanType: "interlaced", audioSamplingRate: 44100 },
      audio: { language: "English", codec: "truehd", profile: "atmos", languageCode: "eng", audioChannelLayout: "7.1" },
      sub: { language: "german" },
      video: { codec: "av1", profile: "high", scanType: "interlaced", videoRangeType: "DOVI", colorPrimaries: "bt2020", colorRange: "pc", chromaSubsampling: "4:4:4" },
    },
  ];
  for (const s of specs) {
    const item = await createTestMediaItem(lib.id, {
      title: s.title, year: s.year, resolution: s.resolution, videoCodec: s.videoCodec, audioCodec: s.audioCodec,
      container: s.container, dynamicRange: s.dynamicRange, audioProfile: s.audioProfile,
      contentRating: s.contentRating, studio: s.studio, genres: s.genres, labels: s.labels, countries: s.countries,
    });
    await prisma.mediaItem.update({ where: { id: item.id }, data: s.raw });
    await createTestMediaStream(item.id, { streamType: 1, ...s.video });
    await createTestMediaStream(item.id, { streamType: 2, ...s.audio });
    await createTestMediaStream(item.id, { streamType: 3, ...s.sub });
    // A lower-case duplicate exercises the case-insensitive dedupe.
    await createTestMediaStream(item.id, { streamType: 2, language: s.audio.language.toLowerCase(), codec: s.audio.codec.toUpperCase() });
  }
  return user;
}

afterAll(async () => {
  await disconnectTestDb();
});

describe.each([
  ["/api/media/distinct-values", mediaGET],
  ["/api/query/distinct-values", queryGET],
] as const)("GET %s — ordering and caching", (url, GET) => {
  beforeEach(async () => {
    appCache.clear();
    await cleanDatabase();
    clearMockSession();
  });

  it("orders every list with more than one value", async () => {
    await seedTwoOfEverything();
    const v = await expectJson<Values>(await callRoute(GET, { url }));

    expect(v.resolution).toEqual(["4K", "720P"]);
    expect(v.videoCodec).toEqual(["av1", "vp9"]);
    expect(v.audioCodec).toEqual(["aac", "opus"]);
    expect(v.container).toEqual(["mkv", "webm"]);
    expect(v.audioProfile).toEqual(["Atmos", "Stereo"]);
    expect(v.contentRating).toEqual(["G", "R"]);
    expect(v.studio).toEqual(["Alpha Studio", "Zeta Films"]);
    expect(v.genre).toEqual(["Action", "war"]);
    expect(v.labels).toEqual(["alabel", "zlabel"]);
    expect(v.country).toEqual(["Austria", "Zambia"]);
    expect(v.year).toEqual([2021, 1999]);
    expect(v.videoBitDepth).toEqual([10, 8]);
    expect(v.videoProfile).toEqual(["high", "main"]);
    expect(v.videoFrameRate).toEqual(["24p", "60p"]);
    expect(v.aspectRatio).toEqual(["1.78", "2.39"]);
    expect(v.scanType).toEqual(["interlaced", "progressive"]);
    expect(v.audioChannels).toEqual([2, 6]);
    expect(v.audioSamplingRate).toEqual([44100, 48000]);

    // Case-insensitive dedupe keeps the capitalised spelling.
    expect(v.audioLanguage).toEqual(["English", "spanish"]);
    expect(v.subtitleLanguage).toEqual(["French", "german"]);
    expect(v.streamAudioCodec).toHaveLength(2);
    expect((v.streamAudioCodec as string[]).map((c) => c.toLowerCase())).toEqual(["aac", "truehd"]);

    expect(v.sqCodec).toEqual(expect.arrayContaining(["av1", "vp9"]));
    expect(v.sqProfile).toEqual(["atmos", "high", "lc", "main"]);
    expect(v.sqLanguageCode).toEqual(["eng", "spa"]);
    expect(v.sqScanType).toEqual(["interlaced", "progressive"]);
    expect(v.sqVideoRangeType).toEqual(["DOVI", "SDR"]);
    expect(v.sqAudioLayout).toEqual(["7.1", "stereo"]);
    expect(v.sqColorPrimaries).toEqual(["bt2020", "bt709"]);
    expect(v.sqColorRange).toEqual(["pc", "tv"]);
    expect(v.sqChromaSubsampling).toEqual(["4:2:0", "4:4:4"]);
  });

  it("serves a second request from the cache until it is cleared", async () => {
    const user = await seedTwoOfEverything();
    const first = await expectJson<Values>(await callRoute(GET, { url }));
    // A new value in the database is not seen while the cache holds.
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(lib.id, { videoCodec: "mpeg2" });
    const second = await expectJson<Values>(await callRoute(GET, { url }));
    expect(second).toEqual(first);

    appCache.clear();
    const third = await expectJson<Values>(await callRoute(GET, { url }));
    expect(third.videoCodec).toContain("mpeg2");
  });
});

describe("GET /api/media/distinct-values — dynamic range rank", () => {
  beforeEach(async () => {
    appCache.clear();
    await cleanDatabase();
    clearMockSession();
  });

  it("orders dynamic ranges best first, unknown ones last", async () => {
    await seedTwoOfEverything();
    const prisma = getTestPrisma();
    const lib = await prisma.library.findFirstOrThrow();
    await createTestMediaItem(lib.id, { dynamicRange: "Mystery" });
    await createTestMediaItem(lib.id, { dynamicRange: "HDR10" });
    const v = await expectJson<Values>(await callRoute(mediaGET, { url: "/api/media/distinct-values" }));
    expect(v.dynamicRange).toEqual(["Dolby Vision", "HDR10", "SDR", "Mystery"]);
  });
});
