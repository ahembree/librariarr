/**
 * The library filter bar's and the Query builder's dropdown values come from
 * one loader (`src/lib/media/distinct-values.ts`). These run against the real
 * cache, which the per-route tests replace with a no-op.
 */
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

import { GET as libraryGet } from "@/app/api/media/distinct-values/route";
import { GET as queryGet } from "@/app/api/query/distinct-values/route";
import { invalidateMediaCaches, invalidateRuleSetNameCaches } from "@/lib/cache/invalidate";
import { dedupeInsensitive } from "@/lib/media/distinct-values";

type Values = Record<string, unknown>;
const library = async () => expectJson<Values>(await callRoute(libraryGet, { url: "/api/media/distinct-values" }));
const query = async () => expectJson<Values>(await callRoute(queryGet, { url: "/api/query/distinct-values" }));

const RANGE_KEYS = [
  "fileSizeMin", "fileSizeMax", "durationMin", "durationMax", "playCountMin", "playCountMax",
  "ratingMin", "ratingMax", "lastPlayedAtMin", "lastPlayedAtMax", "addedAtMin", "addedAtMax",
  "audioStreamCountMin", "audioStreamCountMax", "subtitleStreamCountMin", "subtitleStreamCountMax",
];

describe("distinct values shared by the library and the Query builder", () => {
  let userId: string;
  let libraryId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    // Both keys outlive a test otherwise: the real cache is in use here.
    invalidateMediaCaches();
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true });
    const server = await createTestServer(userId);
    libraryId = (await createTestLibrary(server.id)).id;
  });

  afterAll(async () => {
    invalidateMediaCaches();
    await disconnectTestDb();
  });

  async function seed() {
    const a = await createTestMediaItem(libraryId, { dynamicRange: "SDR", videoCodec: "hevc", genres: ["Drama"] });
    const b = await createTestMediaItem(libraryId, { dynamicRange: "Dolby Vision", videoCodec: "h264", genres: ["drama", "Sci-Fi"] });
    await createTestMediaItem(libraryId, { dynamicRange: "HDR10", videoCodec: "av1" });
    await createTestMediaStream(a.id, { streamType: 2, language: "english", codec: "aac", audioChannelLayout: "stereo" });
    await createTestMediaStream(a.id, { streamType: 2, language: "English", codec: "AAC", audioChannelLayout: "5.1(side)" });
    await createTestMediaStream(b.id, { streamType: 3, language: "French", languageCode: "fre", codec: "srt" });
    await createTestMediaStream(b.id, { streamType: 3, language: "Unknown", codec: "pgs" });
    await createTestMediaStream(b.id, { streamType: 1, codec: "hevc", profile: "main 10", colorPrimaries: "bt2020", colorRange: "tv", chromaSubsampling: "4:2:0", videoRangeType: "DOVI", scanType: "progressive" });
  }

  it("answers the Query builder with the library's values, less the ranges and with Dynamic Range alphabetical", async () => {
    await seed();
    const lib = await library();
    const qry = await query();

    const shared = Object.keys(lib).filter((key) => !RANGE_KEYS.includes(key));
    expect(Object.keys(qry)).toEqual(shared);
    for (const key of shared) {
      if (key === "dynamicRange") continue;
      expect(qry[key], key).toEqual(lib[key]);
    }
    expect(lib.dynamicRange).toEqual(["Dolby Vision", "HDR10", "SDR"]);
    expect(qry.dynamicRange).toEqual(["Dolby Vision", "HDR10", "SDR"].sort((x, y) => x.localeCompare(y)));
    // The stream values read from the stream combinations, as from the rows.
    expect(lib.audioLanguage).toEqual(["English"]);
    expect(lib.subtitleLanguage).toEqual(["French", "Unknown"]);
    expect(lib.sqLanguage).toEqual(["English", "French"]);
    expect(lib.sqCodec).toEqual(["AAC", "hevc", "pgs", "srt"]);
    expect(lib.sqAudioLayout).toEqual(["5.1(side)", "stereo"]);
    expect(lib.genre).toEqual(["Drama", "Sci-Fi"]);
    expect(lib.audioStreamCountMax).toBe(2);
  });

  it("computes each answer once for requests that arrive together, and keeps it", async () => {
    await seed();
    const spy = vi.spyOn(getTestPrisma(), "$queryRawUnsafe");
    try {
      const answers = await Promise.all([library(), library(), library(), query(), query()]);
      // The stream-combination statement is the one raw-unsafe read, made once per key.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(answers[1]).toEqual(answers[0]);
      expect(answers[4]).toEqual(answers[3]);
      await library();
      await query();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("re-reads after a media change or a rule set rename drops the cached answers", async () => {
    await seed();
    expect(((await library()).videoCodec as string[])).not.toContain("vp9");
    expect(((await query()).videoCodec as string[])).not.toContain("vp9");
    await createTestMediaItem(libraryId, { videoCodec: "vp9" });
    // Still the cached answers until something drops them.
    expect(((await library()).videoCodec as string[])).not.toContain("vp9");
    expect(((await query()).videoCodec as string[])).not.toContain("vp9");
    invalidateMediaCaches();
    expect(((await library()).videoCodec as string[])).toContain("vp9");
    expect(((await query()).videoCodec as string[])).toContain("vp9");

    await getTestPrisma().ruleSet.create({ data: { userId, name: "Keep", type: "MOVIE", rules: [] } });
    invalidateRuleSetNameCaches();
    expect((await library()).matchedByRuleSet).toEqual(["Keep"]);
    expect((await query()).matchedByRuleSet).toEqual(["Keep"]);
  });
});

describe("dedupeInsensitive", () => {
  it("keeps one spelling per value, preferring one that starts upper-case", () => {
    expect(dedupeInsensitive(["english", "English", "french"])).toEqual(["English", "french"]);
    expect(dedupeInsensitive(["5.1", "stereo", "Stereo"])).toEqual(["5.1", "Stereo"]);
  });
});
