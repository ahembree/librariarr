import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
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

import { computeTimeline } from "@/lib/media/timeline";
import { computeCrossTab } from "@/lib/media/cross-tab";
import { computeBreakdown } from "@/lib/media/breakdown";
import type { DimensionMeta } from "@/lib/dashboard/custom-dimensions";

// ── Dimension fixtures (shapes as in DIMENSION_REGISTRY) ──
const codec: DimensionMeta = {
  id: "videoCodec", label: "Video Codec", group: "Video", dbField: "videoCodec",
  category: "direct", nullLabel: "Unknown", excludeTypes: ["MUSIC"],
};
const container: DimensionMeta = {
  id: "container", label: "Container", group: "File", dbField: "container", category: "direct", nullLabel: "None",
};
const resolutionMap: DimensionMeta = {
  id: "resolution", label: "Resolution", group: "Video", dbField: "resolution", category: "value_map",
  nullLabel: "Unknown", valueMapFn: (raw) => (raw == null ? "Unknown" : raw.startsWith("2160") ? "4K" : "HD"),
};
const sizeBuckets: DimensionMeta = {
  id: "fileSize", label: "File Size", group: "File", dbField: "fileSize", category: "numeric_bucket",
  nullLabel: "Unknown",
  // A gap between 2000 and 3000 falls through to the null label.
  bucketConfig: { ranges: [[null, 1000, "Small"], [1000, 2000, "Medium"], [3000, null, "Large"]] },
};
// Contiguous ranges, as every registry entry has.
const sizeBucketsContiguous: DimensionMeta = {
  ...sizeBuckets,
  bucketConfig: { ranges: [[null, 1000, "Small"], [1000, 3000, "Medium"], [3000, null, "Large"]] },
};
const genres: DimensionMeta = {
  id: "genre", label: "Genre", group: "Content", dbField: "genres", category: "json_unnest", nullLabel: "Unknown",
};
const addedYear: DimensionMeta = {
  id: "addedAt", label: "Added", group: "Dates", dbField: "addedAt", category: "date_bucket",
  nullLabel: "Unknown", dateBucketGranularity: "year",
};
const addedMonth: DimensionMeta = { ...addedYear, dateBucketGranularity: "month" };
const playedMonth: DimensionMeta = {
  id: "lastPlayedAt", label: "Last Played", group: "Dates", dbField: "lastPlayedAt", category: "date_bucket",
  nullLabel: "Never", dateBucketGranularity: "month",
};
const audioLang: DimensionMeta = {
  id: "audioLanguage", label: "Audio Language", group: "Streams", dbField: "language", category: "stream_group",
  nullLabel: "Unknown", streamType: 2, streamField: "language",
};

const base = { measure: "count", breakdownMeta: null, typeFilter: null, topN: null, dedupEnabled: false };

describe("media stats compute (timeline, cross-tab, breakdown)", () => {
  let serverId: string;
  let movieLib: string;
  let musicLib: string;

  beforeEach(async () => {
    await cleanDatabase();
    const user = await createTestUser();
    serverId = (await createTestServer(user.id)).id;
    movieLib = (await createTestLibrary(serverId, { type: "MOVIE" })).id;
    musicLib = (await createTestLibrary(serverId, { type: "MUSIC" })).id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function movie(addedAt: string, extra: Parameters<typeof createTestMediaItem>[1] = {}) {
    return createTestMediaItem(movieLib, { type: "MOVIE", addedAt: new Date(addedAt), ...extra });
  }

  describe("computeTimeline", () => {
    it("fills every day, week, quarter and year between the first and last bucket", async () => {
      await movie("2024-03-01T12:00:00Z");
      await movie("2024-03-04T12:00:00Z");
      const run = (bin: string) => computeTimeline({ ...base, dateField: "addedAt", bin, serverIds: [serverId] });

      const day = await run("day");
      expect(day.points.map((p) => [p.date, p.total])).toEqual([
        ["2024-03-01", 1], ["2024-03-02", 0], ["2024-03-03", 0], ["2024-03-04", 1],
      ]);
      expect(day.series).toEqual([]);

      // 2024-03-01 is a Friday: its week starts 2024-02-26, the other's 2024-03-04.
      const week = await run("week");
      expect(week.points.map((p) => p.date)).toEqual(["2024-02-26", "2024-03-04"]);

      await movie("2024-11-15T12:00:00Z");
      const quarter = await run("quarter");
      expect(quarter.points.map((p) => [p.date, p.total])).toEqual([
        ["2024-Q1", 2], ["2024-Q2", 0], ["2024-Q3", 0], ["2024-Q4", 1],
      ]);

      await movie("2021-06-01T12:00:00Z");
      const year = await run("year");
      expect(year.points.map((p) => [p.date, p.total])).toEqual([
        ["2021", 1], ["2022", 0], ["2023", 0], ["2024", 3],
      ]);
    });

    it("leaves an unknown bin unfilled and a single point alone", async () => {
      await movie("2024-01-10T12:00:00Z");
      const single = await computeTimeline({ ...base, dateField: "addedAt", bin: "month", serverIds: [serverId] });
      expect(single.points).toEqual([{ date: "2024-01", total: 1 }]);

      await movie("2024-04-10T12:00:00Z");
      // An unknown bin buckets by month but cannot be walked, so no gaps are filled.
      const bogus = await computeTimeline({ ...base, dateField: "addedAt", bin: "fortnight", serverIds: [serverId] });
      expect(bogus.points.map((p) => p.date)).toEqual(["2024-01", "2024-04"]);
    });

    it("returns the real points unfilled when the range is too wide to fill", async () => {
      await movie("1990-01-01T12:00:00Z");
      await movie("2024-01-01T12:00:00Z");
      const { points } = await computeTimeline({ ...base, dateField: "addedAt", bin: "day", serverIds: [serverId] });
      expect(points.map((p) => p.date)).toEqual(["1990-01-01", "2024-01-01"]);
    });

    it("keeps a year the walk cannot reproduce instead of hiding it behind zeros", async () => {
      await movie("0050-06-01T12:00:00Z");
      await movie("2000-06-01T12:00:00Z");
      const { points } = await computeTimeline({ ...base, dateField: "addedAt", bin: "year", serverIds: [serverId] });
      expect(points.map((p) => p.date)).toEqual(["0050", "2000"]);
    });

    it("sums file size, narrows by type and honours dedup", async () => {
      await movie("2024-01-10T12:00:00Z", { fileSize: BigInt(1500) });
      const twin = await movie("2024-01-11T12:00:00Z", { fileSize: BigInt(500) });
      await getTestPrisma().mediaItem.update({ where: { id: twin.id }, data: { dedupCanonical: false } });
      await createTestMediaItem(musicLib, { type: "MUSIC", addedAt: new Date("2024-01-12T00:00:00Z"), fileSize: BigInt(7) });

      const size = await computeTimeline({ ...base, measure: "size", dateField: "addedAt", bin: "month", serverIds: [serverId] });
      expect(size.points).toEqual([{ date: "2024-01", total: 2007 }]);

      const movies = await computeTimeline({ ...base, typeFilter: "MOVIE", dateField: "addedAt", bin: "month", serverIds: [serverId] });
      expect(movies.points).toEqual([{ date: "2024-01", total: 2 }]);

      const deduped = await computeTimeline({ ...base, dedupEnabled: true, typeFilter: "MOVIE", dateField: "addedAt", bin: "month", serverIds: [serverId] });
      expect(deduped.points).toEqual([{ date: "2024-01", total: 1 }]);
    });

    it("falls back to a plain timeline for a dimension that cannot colour one", async () => {
      await movie("2024-01-10T12:00:00Z", { genres: ["Drama"] });
      await movie("2024-03-10T12:00:00Z");
      for (const meta of [genres, { ...sizeBuckets, bucketConfig: undefined }]) {
        const r = await computeTimeline({ ...base, breakdownMeta: meta, dateField: "addedAt", bin: "month", serverIds: [serverId] });
        expect(r.series).toEqual([]);
        expect(r.points.map((p) => [p.date, p.total])).toEqual([["2024-01", 1], ["2024-02", 0], ["2024-03", 1]]);
        expect(r.points[0].breakdown).toBeUndefined();
      }
    });

    it("breaks a timeline down by a direct field, rolls the rest into Other and zero-fills gaps", async () => {
      await movie("2024-01-10T12:00:00Z", { videoCodec: "hevc" });
      await movie("2024-01-11T12:00:00Z", { videoCodec: "hevc" });
      await movie("2024-01-12T12:00:00Z", { videoCodec: "h264" });
      await movie("2024-03-12T12:00:00Z", { videoCodec: "av1" });
      await movie("2024-03-13T12:00:00Z", { videoCodec: "vp9" });
      // A track has no video codec and is left out rather than charted as Unknown.
      await createTestMediaItem(musicLib, { type: "MUSIC", addedAt: new Date("2024-01-10T00:00:00Z") });

      const all = await computeTimeline({ ...base, breakdownMeta: codec, dateField: "addedAt", bin: "month", serverIds: [serverId] });
      // The most frequent codec leads; the track is not charted at all.
      expect(all.series[0]).toBe("hevc");
      expect([...all.series].sort()).toEqual(["av1", "h264", "hevc", "vp9"]);
      expect(all.points[0].total).toBe(3);

      const top = await computeTimeline({ ...base, breakdownMeta: codec, topN: 1, dateField: "addedAt", bin: "month", serverIds: [serverId] });
      expect(top.series).toEqual(["hevc", "Other"]);
      expect(top.points).toEqual([
        { date: "2024-01", total: 3, breakdown: { hevc: 2, Other: 1 } },
        { date: "2024-02", total: 0, breakdown: { hevc: 0, Other: 0 } },
        { date: "2024-03", total: 2, breakdown: { hevc: 0, Other: 2 } },
      ]);
    });

    it("maps values and buckets numbers for the breakdown", async () => {
      await movie("2024-01-10T12:00:00Z", { resolution: "2160p", fileSize: BigInt(500) });
      await movie("2024-01-11T12:00:00Z", { resolution: "1080p", fileSize: BigInt(1500) });
      await movie("2024-01-12T12:00:00Z", { resolution: "720p", fileSize: BigInt(2500) });
      const nullRes = await movie("2024-01-13T12:00:00Z", { fileSize: BigInt(5000) });
      await getTestPrisma().mediaItem.update({ where: { id: nullRes.id }, data: { resolution: null, fileSize: null } });

      const mapped = await computeTimeline({ ...base, breakdownMeta: resolutionMap, dateField: "addedAt", bin: "month", serverIds: [serverId] });
      expect(mapped.points[0].breakdown).toEqual({ HD: 2, "4K": 1, Unknown: 1 });

      const sized = await computeTimeline({ ...base, breakdownMeta: sizeBucketsContiguous, dateField: "addedAt", bin: "month", serverIds: [serverId] });
      expect(sized.points[0].breakdown).toEqual({ Small: 1, Medium: 2, Unknown: 1 });
    });
  });

  describe("computeCrossTab", () => {
    async function seedCross() {
      const prisma = getTestPrisma();
      const a = await movie("2023-05-02T00:30:00Z", {
        videoCodec: "hevc", container: "mkv", resolution: "2160p", fileSize: BigInt(500), genres: ["Drama", "Crime"],
        lastPlayedAt: new Date("2024-02-02T00:00:00Z"),
      });
      const b = await movie("2024-07-01T00:00:00Z", {
        videoCodec: "hevc", container: "mp4", resolution: "1080p", fileSize: BigInt(2500),
      });
      const c = await movie("2024-07-02T00:00:00Z", { videoCodec: "h264", container: "mkv", fileSize: BigInt(4000), genres: ["Drama"] });
      await prisma.mediaItem.update({ where: { id: c.id }, data: { dedupCanonical: false, resolution: null } });
      await createTestMediaStream(a.id, { streamType: 2, language: "English" });
      await createTestMediaStream(a.id, { streamType: 2, language: "English", index: 2 });
      await createTestMediaStream(b.id, { streamType: 2, language: "French" });
      await createTestMediaStream(c.id, { streamType: 2 });
      return { a, b, c };
    }

    const sortRows = <T extends { dim1: string | null; dim2: string | null }>(rows: T[]) =>
      [...rows].sort((x, y) => `${x.dim1}|${x.dim2}`.localeCompare(`${y.dim1}|${y.dim2}`));

    it("cross-tabulates two direct fields in SQL, with dedup", async () => {
      await seedCross();
      const rows = await computeCrossTab(codec, container, [serverId], false);
      expect(sortRows(rows)).toEqual([
        { dim1: "h264", dim2: "mkv", type: "MOVIE", _count: 1 },
        { dim1: "hevc", dim2: "mkv", type: "MOVIE", _count: 1 },
        { dim1: "hevc", dim2: "mp4", type: "MOVIE", _count: 1 },
      ]);
      // c (the h264 one) is not canonical.
      const deduped = await computeCrossTab(codec, container, [serverId], true);
      expect(sortRows(deduped)).toEqual([
        { dim1: "hevc", dim2: "mkv", type: "MOVIE", _count: 1 },
        { dim1: "hevc", dim2: "mp4", type: "MOVIE", _count: 1 },
      ]);
    });

    it("cross-tabulates a mapped value against every genre of an item", async () => {
      await seedCross();
      const rows = await computeCrossTab(resolutionMap, genres, [serverId], false);
      expect(sortRows(rows)).toEqual([
        { dim1: "4K", dim2: "Crime", type: "MOVIE", _count: 1 },
        { dim1: "4K", dim2: "Drama", type: "MOVIE", _count: 1 },
        { dim1: "Unknown", dim2: "Drama", type: "MOVIE", _count: 1 },
      ]);
    });

    it("buckets numbers and dates (UTC), with null and out-of-range values labelled", async () => {
      await seedCross();
      const byYear = await computeCrossTab(sizeBuckets, addedYear, [serverId], false);
      expect(sortRows(byYear)).toEqual([
        { dim1: "Large", dim2: "2024", type: "MOVIE", _count: 1 },
        { dim1: "Small", dim2: "2023", type: "MOVIE", _count: 1 },
        { dim1: "Unknown", dim2: "2024", type: "MOVIE", _count: 1 },
      ]);
      const byMonth = await computeCrossTab(playedMonth, addedMonth, [serverId], true);
      expect(sortRows(byMonth)).toEqual([
        { dim1: "2024-02", dim2: "2023-05", type: "MOVIE", _count: 1 },
        { dim1: "Never", dim2: "2024-07", type: "MOVIE", _count: 1 },
      ]);
    });

    it("joins streams for a stream dimension on either side, counting an item once per language", async () => {
      await seedCross();
      const first = await computeCrossTab(audioLang, codec, [serverId], false);
      expect(sortRows(first)).toEqual([
        { dim1: "English", dim2: "hevc", type: "MOVIE", _count: 1 },
        { dim1: "French", dim2: "hevc", type: "MOVIE", _count: 1 },
        { dim1: "Unknown", dim2: "h264", type: "MOVIE", _count: 1 },
      ]);
      const second = await computeCrossTab(container, audioLang, [serverId], true);
      expect(sortRows(second)).toEqual([
        { dim1: "mkv", dim2: "English", type: "MOVIE", _count: 1 },
        { dim1: "mp4", dim2: "French", type: "MOVIE", _count: 1 },
      ]);
    });

    it("labels an unrecognised dimension category with its null label", async () => {
      await seedCross();
      const odd = { ...container, category: "mystery" } as unknown as DimensionMeta;
      const rows = await computeCrossTab(odd, sizeBuckets, [serverId], false);
      expect(new Set(rows.map((r) => r.dim1))).toEqual(new Set(["None"]));
      expect(rows.reduce((n, r) => n + r._count, 0)).toBe(3);
    });
  });

  describe("computeBreakdown", () => {
    it("groups by stream language, counting each item once", async () => {
      const a = await movie("2024-01-01T00:00:00Z");
      const b = await movie("2024-01-01T00:00:00Z");
      await createTestMediaStream(a.id, { streamType: 2, language: "English" });
      await createTestMediaStream(a.id, { streamType: 2, language: "English", index: 2 });
      await createTestMediaStream(b.id, { streamType: 2 });
      await createTestMediaStream(b.id, { streamType: 3, language: "German" });
      const rows = await computeBreakdown(audioLang, [serverId], false);
      expect(rows.sort((x, y) => String(x.value).localeCompare(String(y.value)))).toEqual([
        { value: "English", type: "MOVIE", _count: 1 },
        { value: "Unknown", type: "MOVIE", _count: 1 },
      ]);
      await getTestPrisma().mediaItem.update({ where: { id: a.id }, data: { dedupCanonical: false } });
      expect(await computeBreakdown(audioLang, [serverId], true)).toEqual([
        { value: "Unknown", type: "MOVIE", _count: 1 },
      ]);
    });

    it("buckets dates by month or year, newest first, with a null label", async () => {
      await movie("2023-05-02T00:00:00Z", { lastPlayedAt: new Date("2024-02-01T00:00:00Z") });
      await movie("2024-07-01T00:00:00Z");
      const twin = await movie("2024-07-03T00:00:00Z");
      await getTestPrisma().mediaItem.update({ where: { id: twin.id }, data: { dedupCanonical: false } });

      expect(await computeBreakdown(addedYear, [serverId], false)).toEqual([
        { value: "2024", type: "MOVIE", _count: 2 },
        { value: "2023", type: "MOVIE", _count: 1 },
      ]);
      expect(await computeBreakdown(addedMonth, [serverId], true)).toEqual([
        { value: "2024-07", type: "MOVIE", _count: 1 },
        { value: "2023-05", type: "MOVIE", _count: 1 },
      ]);
      const played = await computeBreakdown(playedMonth, [serverId], false);
      // Exactly these two rows; where the null label sorts is not the point here.
      expect(played).toHaveLength(2);
      expect(played).toEqual(expect.arrayContaining([
        { value: "Never", type: "MOVIE", _count: 2 },
        { value: "2024-02", type: "MOVIE", _count: 1 },
      ]));
    });

    it("buckets numbers and unnests genres under dedup", async () => {
      await movie("2024-01-01T00:00:00Z", { fileSize: BigInt(10), genres: ["Drama"] });
      const twin = await movie("2024-01-01T00:00:00Z", { fileSize: BigInt(1200), genres: ["Drama", "War"] });
      await getTestPrisma().mediaItem.update({ where: { id: twin.id }, data: { dedupCanonical: false } });
      expect(await computeBreakdown(sizeBuckets, [serverId], true)).toEqual([
        { value: "Small", type: "MOVIE", _count: 1 },
      ]);
      expect(await computeBreakdown(genres, [serverId], true)).toEqual([
        { value: "Drama", type: "MOVIE", _count: 1 },
      ]);
    });

    it("refuses a column outside the allow-list before building raw SQL", async () => {
      const evil = { ...genres, dbField: 'genres" OR 1=1 --' };
      await expect(computeBreakdown(evil, [serverId], false)).rejects.toThrow(/Disallowed column/);
      const evilStream = { ...audioLang, streamField: "codec" };
      await expect(computeBreakdown(evilStream, [serverId], false)).rejects.toThrow(/Disallowed column/);
    });
  });
});
