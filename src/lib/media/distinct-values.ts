import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { appCache } from "@/lib/cache/memory-cache";
import { completedPlaySql } from "@/lib/media/watch-completion";
import { normalizeResolutionLabel } from "@/lib/resolution";

/**
 * The dropdown values behind the library filter bar
 * (`GET /api/media/distinct-values`) and the Query builder
 * (`GET /api/query/distinct-values`), from one loader.
 *
 * The two routes ran the same statements from two copies of the same code.
 * The Query builder's answer is the library's without the numeric ranges and
 * stream-count ranges (which only the filter bar's sliders read), and with
 * Dynamic Range listed alphabetically rather than by rank. Each keeps its own
 * cache key — `invalidateMediaCaches()` drops both prefixes, and
 * `invalidateRuleSetNameCaches()` names both keys.
 */
export type DistinctValuesKind = "library" | "query";

const CACHE_KEYS: Record<DistinctValuesKind, string> = {
  library: "distinct-values",
  query: "query-distinct-values",
};
/** 5 minutes: these only change on a sync, which drops them anyway. */
const CACHE_TTL_MS = 5 * 60_000;

/**
 * The cached answer, computed once however many requests miss at the same
 * moment (`getOrSet` is single-flight; the routes used `get` then `set`, so
 * every request that arrived while the first was computing ran the whole set
 * of scans again).
 */
export function getDistinctValues(userId: string, kind: DistinctValuesKind): Promise<Record<string, unknown>> {
  return appCache.getOrSet(CACHE_KEYS[kind], () => computeDistinctValues(userId, kind), CACHE_TTL_MS);
}

const STANDARD_RESOLUTIONS = ["4K", "1080P", "720P", "480P", "SD", "Other"];

const DYNAMIC_RANGE_RANK: Record<string, number> = {
  "dolby vision": 6,
  "hdr10+": 5,
  hdr10: 4,
  hdr: 3,
  hlg: 2,
  sdr: 1,
};

function dynamicRangeRank(r: string): number {
  return DYNAMIC_RANGE_RANK[r.toLowerCase()] ?? 0;
}

/** Deduplicate strings case-insensitively, preferring the title-cased variant. */
export function dedupeInsensitive(values: string[]): string[] {
  const map = new Map<string, string>();
  for (const v of values) {
    const key = v.toLowerCase();
    // Keep the version that starts with an uppercase letter
    if (!map.has(key) || (v[0] === v[0].toUpperCase() && v[0] !== v[0].toLowerCase())) {
      map.set(key, v);
    }
  }
  return Array.from(map.values());
}

/** One value per spelling ignoring case, the first one seen (the JSON tag lists). */
function firstSpellings(values: string[]): string[] {
  const map = new Map<string, string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (!map.has(key)) map.set(key, value);
  }
  return Array.from(map.values());
}

const byText = (a: string, b: string) => a.localeCompare(b);
const sortedText = (values: string[] | null | undefined) => (values ?? []).sort(byText);
const sortedInsensitive = (values: string[] | null | undefined) => dedupeInsensitive(values ?? []).sort(byText);
const dateOnly = (value: Date | null) => (value ? value.toISOString().split("T")[0] : null);

interface AggRow {
  resolutions: string[] | null;
  videoCodecs: string[] | null;
  audioCodecs: string[] | null;
  containers: string[] | null;
  dynamicRanges: string[] | null;
  audioProfiles: string[] | null;
  contentRatings: string[] | null;
  studios: string[] | null;
  videoBitDepths: number[] | null;
  audioChannelsArr: number[] | null;
  years: number[] | null;
  videoProfiles: string[] | null;
  videoFrameRates: string[] | null;
  aspectRatios: string[] | null;
  scanTypes: string[] | null;
  audioSamplingRates: number[] | null;
  fileSizeMin: bigint | null;
  fileSizeMax: bigint | null;
  durationMin: number | null;
  durationMax: number | null;
  playCountMin: number | null;
  playCountMax: number | null;
  ratingMin: number | null;
  ratingMax: number | null;
  lastPlayedAtMin: Date | null;
  lastPlayedAtMax: Date | null;
  addedAtMin: Date | null;
  addedAtMax: Date | null;
}

interface StreamDistinctRow {
  audioLanguages: string[] | null;
  subtitleLanguages: string[] | null;
  streamAudioCodecs: string[] | null;
  codecs: string[] | null;
  profiles: string[] | null;
  languages: string[] | null;
  languageCodes: string[] | null;
  sqScanTypes: string[] | null;
  videoRangeTypes: string[] | null;
  audioLayouts: string[] | null;
  colorPrimaries: string[] | null;
  colorRanges: string[] | null;
  chromaSubsamplings: string[] | null;
}

interface StreamCountRow {
  audioCountMin: number | null;
  audioCountMax: number | null;
  subtitleCountMin: number | null;
  subtitleCountMax: number | null;
}

/** Every column a stream dropdown reads. */
const STREAM_COLUMNS = `"streamType", language, codec, profile, "languageCode", "scanType",
  "videoRangeType", "audioChannelLayout", "colorPrimaries", "colorRange", "chromaSubsampling"`;

export async function computeDistinctValues(userId: string, kind: DistinctValuesKind): Promise<Record<string, unknown>> {
  // Single-pass aggregation: all distinct values + min/max ranges in one query
  // (the Query builder ignores the ranges; computing them in the same scan
  // costs it nothing). Genres require a separate query due to CROSS JOIN
  // LATERAL on JSONB arrays.
  const [aggRows, genres, labelRows, countryRows, streamDistinct, streamCounts, ruleSets, watchUsers] = await Promise.all([
    prisma.$queryRaw<AggRow[]>`
      SELECT
        array_agg(DISTINCT resolution) FILTER (WHERE resolution IS NOT NULL) AS resolutions,
        array_agg(DISTINCT "videoCodec") FILTER (WHERE "videoCodec" IS NOT NULL) AS "videoCodecs",
        array_agg(DISTINCT "audioCodec") FILTER (WHERE "audioCodec" IS NOT NULL) AS "audioCodecs",
        array_agg(DISTINCT container) FILTER (WHERE container IS NOT NULL) AS containers,
        array_agg(DISTINCT "dynamicRange") FILTER (WHERE "dynamicRange" IS NOT NULL) AS "dynamicRanges",
        array_agg(DISTINCT "audioProfile") FILTER (WHERE "audioProfile" IS NOT NULL) AS "audioProfiles",
        array_agg(DISTINCT "contentRating") FILTER (WHERE "contentRating" IS NOT NULL) AS "contentRatings",
        array_agg(DISTINCT studio) FILTER (WHERE studio IS NOT NULL) AS studios,
        array_agg(DISTINCT "videoBitDepth") FILTER (WHERE "videoBitDepth" IS NOT NULL) AS "videoBitDepths",
        array_agg(DISTINCT "audioChannels") FILTER (WHERE "audioChannels" IS NOT NULL) AS "audioChannelsArr",
        array_agg(DISTINCT year) FILTER (WHERE year IS NOT NULL) AS years,
        array_agg(DISTINCT "videoProfile") FILTER (WHERE "videoProfile" IS NOT NULL) AS "videoProfiles",
        array_agg(DISTINCT "videoFrameRate") FILTER (WHERE "videoFrameRate" IS NOT NULL) AS "videoFrameRates",
        array_agg(DISTINCT "aspectRatio") FILTER (WHERE "aspectRatio" IS NOT NULL) AS "aspectRatios",
        array_agg(DISTINCT "scanType") FILTER (WHERE "scanType" IS NOT NULL) AS "scanTypes",
        array_agg(DISTINCT "audioSamplingRate") FILTER (WHERE "audioSamplingRate" IS NOT NULL) AS "audioSamplingRates",
        MIN("fileSize") AS "fileSizeMin",
        MAX("fileSize") AS "fileSizeMax",
        MIN(duration) AS "durationMin",
        MAX(duration) AS "durationMax",
        MIN("playCount") AS "playCountMin",
        MAX("playCount") AS "playCountMax",
        MIN(rating) AS "ratingMin",
        MAX(rating) AS "ratingMax",
        MIN("lastPlayedAt") AS "lastPlayedAtMin",
        MAX("lastPlayedAt") AS "lastPlayedAtMax",
        MIN("addedAt") AS "addedAtMin",
        MAX("addedAt") AS "addedAtMax"
      FROM "MediaItem"
    `,
    prisma.$queryRaw<{ genre: string }[]>`
      SELECT DISTINCT g.genre AS "genre"
      FROM "MediaItem" mi
      CROSS JOIN LATERAL jsonb_array_elements_text(mi.genres) AS g(genre)
      WHERE mi.genres IS NOT NULL AND jsonb_typeof(mi.genres) = 'array'
      ORDER BY g.genre
    `,
    // Labels (JSONB array, same shape as genres) for the enumerable `labels` field.
    prisma.$queryRaw<{ label: string }[]>`
      SELECT DISTINCT l.label AS "label"
      FROM "MediaItem" mi
      CROSS JOIN LATERAL jsonb_array_elements_text(mi.labels) AS l(label)
      WHERE mi.labels IS NOT NULL AND jsonb_typeof(mi.labels) = 'array'
      ORDER BY l.label
    `,
    // Countries (JSONB array, same shape as genres) for the enumerable
    // `country` field. Only movies carry country tags today.
    prisma.$queryRaw<{ country: string }[]>`
      SELECT DISTINCT c.country AS "country"
      FROM "MediaItem" mi
      CROSS JOIN LATERAL jsonb_array_elements_text(mi.countries) AS c(country)
      WHERE mi.countries IS NOT NULL AND jsonb_typeof(mi.countries) = 'array'
      ORDER BY c.country
    `,
    // Every stream-level distinct value (the library's language/codec fields
    // and the stream query's per-stream fields) in one statement, over the
    // distinct COMBINATIONS of the columns they read rather than over every
    // stream. A library has hundreds of thousands of streams and a few
    // thousand combinations at most, and each `array_agg(DISTINCT …)` sorts its
    // input: two statements of them over the raw rows took ~830 ms wall for
    // 720k streams (each aggregate a separate sort), this ~130 ms — the same
    // arrays, in the same order.
    prisma.$queryRawUnsafe<StreamDistinctRow[]>(`
      SELECT
        array_agg(DISTINCT language) FILTER (WHERE language IS NOT NULL AND "streamType" = 2) AS "audioLanguages",
        array_agg(DISTINCT language) FILTER (WHERE language IS NOT NULL AND "streamType" = 3) AS "subtitleLanguages",
        array_agg(DISTINCT codec) FILTER (WHERE codec IS NOT NULL AND "streamType" = 2) AS "streamAudioCodecs",
        array_agg(DISTINCT codec) FILTER (WHERE codec IS NOT NULL) AS codecs,
        array_agg(DISTINCT profile) FILTER (WHERE profile IS NOT NULL) AS profiles,
        array_agg(DISTINCT language) FILTER (WHERE language IS NOT NULL AND language != '' AND language != 'Unknown') AS languages,
        array_agg(DISTINCT "languageCode") FILTER (WHERE "languageCode" IS NOT NULL AND "languageCode" != '') AS "languageCodes",
        array_agg(DISTINCT "scanType") FILTER (WHERE "scanType" IS NOT NULL) AS "sqScanTypes",
        array_agg(DISTINCT "videoRangeType") FILTER (WHERE "videoRangeType" IS NOT NULL) AS "videoRangeTypes",
        array_agg(DISTINCT "audioChannelLayout") FILTER (WHERE "audioChannelLayout" IS NOT NULL) AS "audioLayouts",
        array_agg(DISTINCT "colorPrimaries") FILTER (WHERE "colorPrimaries" IS NOT NULL) AS "colorPrimaries",
        array_agg(DISTINCT "colorRange") FILTER (WHERE "colorRange" IS NOT NULL) AS "colorRanges",
        array_agg(DISTINCT "chromaSubsampling") FILTER (WHERE "chromaSubsampling" IS NOT NULL) AS "chromaSubsamplings"
      FROM (SELECT ${STREAM_COLUMNS} FROM "MediaStream" GROUP BY ${STREAM_COLUMNS}) combos
    `),
    // Stream count ranges per item (audio, subtitle) — the library filter
    // bar's track-count sliders only.
    kind === "library"
      ? prisma.$queryRaw<StreamCountRow[]>`
          SELECT
            MIN(audio_count)::int AS "audioCountMin",
            MAX(audio_count)::int AS "audioCountMax",
            MIN(sub_count)::int AS "subtitleCountMin",
            MAX(sub_count)::int AS "subtitleCountMax"
          FROM (
            SELECT
              COUNT(*) FILTER (WHERE "streamType" = 2) AS audio_count,
              COUNT(*) FILTER (WHERE "streamType" = 3) AS sub_count
            FROM "MediaStream"
            GROUP BY "mediaItemId"
          ) counts
        `
      : Promise.resolve<StreamCountRow[]>([]),
    // Rule set names for cross-system "Matched By Rule Set" field
    prisma.ruleSet.findMany({
      where: { userId },
      select: { name: true },
      orderBy: { name: "asc" },
    }),
    // Distinct server usernames from per-user watch history for the
    // `watchedByUser` field. Scoped via the user→server join to mirror the
    // ruleSets query above; under single-user this matches every server.
    // Only users with a COMPLETED play: the rule matches on that predicate in
    // both phases, so a user whose only rows are partial Tracearr plays was
    // offered as a value no rule could ever match.
    prisma.$queryRaw<{ serverUsername: string }[]>`
      SELECT DISTINCT wh."serverUsername" AS "serverUsername"
      FROM "WatchHistory" wh
      JOIN "MediaServer" ms ON wh."mediaServerId" = ms.id
      WHERE ms."userId" = ${userId}
        AND wh."serverUsername" IS NOT NULL
        AND wh."serverUsername" != ''
        AND ${Prisma.raw(completedPlaySql("wh"))}
      ORDER BY wh."serverUsername" ASC
    `,
  ]);

  const r = aggRows[0];
  const sd = streamDistinct[0];

  const enumerable = {
    resolution: STANDARD_RESOLUTIONS.filter((std) =>
      (r.resolutions ?? []).some((v) => normalizeResolutionLabel(v) === std)
    ),
    videoCodec: sortedText(r.videoCodecs),
    audioCodec: sortedText(r.audioCodecs),
    container: sortedText(r.containers),
    // The filter bar ranks Dynamic Range best first; the Query builder lists
    // it alphabetically, as it always has.
    dynamicRange:
      kind === "library"
        ? (r.dynamicRanges ?? []).sort((a, b) => dynamicRangeRank(b) - dynamicRangeRank(a))
        : sortedText(r.dynamicRanges),
    audioProfile: sortedText(r.audioProfiles),
    contentRating: sortedText(r.contentRatings),
    studio: sortedText(r.studios),
    // Deduplicated ignoring case, keeping the first spelling (the queries
    // order them), as the genre filter matches every spelling of one.
    genre: firstSpellings(genres.map((g) => g.genre)).sort(byText),
    labels: firstSpellings(labelRows.map((l) => l.label)).sort(byText),
    country: firstSpellings(countryRows.map((c) => c.country)).sort(byText),
    year: (r.years ?? []).sort((a, b) => b - a),
    videoBitDepth: (r.videoBitDepths ?? []).sort((a, b) => b - a),
    videoProfile: sortedText(r.videoProfiles),
    videoFrameRate: sortedText(r.videoFrameRates),
    aspectRatio: sortedText(r.aspectRatios),
    scanType: sortedText(r.scanTypes),
    audioChannels: (r.audioChannelsArr ?? []).sort((a, b) => a - b),
    audioSamplingRate: (r.audioSamplingRates ?? []).sort((a, b) => a - b),
  };
  // Stream-level distinct values
  const streamValues = {
    audioLanguage: sortedInsensitive(sd?.audioLanguages),
    subtitleLanguage: sortedInsensitive(sd?.subtitleLanguages),
    streamAudioCodec: sortedInsensitive(sd?.streamAudioCodecs),
  };
  // Stream query distinct values (per-stream fields)
  const streamQueryValues = {
    sqCodec: sortedInsensitive(sd?.codecs),
    sqProfile: sortedInsensitive(sd?.profiles),
    sqLanguage: sortedInsensitive(sd?.languages),
    sqLanguageCode: sortedInsensitive(sd?.languageCodes),
    sqScanType: sortedInsensitive(sd?.sqScanTypes),
    sqVideoRangeType: sortedInsensitive(sd?.videoRangeTypes),
    sqAudioLayout: sortedInsensitive(sd?.audioLayouts),
    sqColorPrimaries: sortedInsensitive(sd?.colorPrimaries),
    sqColorRange: sortedInsensitive(sd?.colorRanges),
    sqChromaSubsampling: sortedInsensitive(sd?.chromaSubsamplings),
  };
  const crossSystem = {
    // Cross-system distinct values
    matchedByRuleSet: ruleSets.map((rs) => rs.name),
    // Per-user watch history — usernames who have ever played a media item.
    watchedByUser: watchUsers.map((u) => u.serverUsername),
  };

  if (kind === "query") {
    return { ...enumerable, ...streamValues, ...streamQueryValues, ...crossSystem };
  }

  const sc = streamCounts[0];
  return {
    ...enumerable,
    fileSizeMin: r.fileSizeMin?.toString() ?? null,
    fileSizeMax: r.fileSizeMax?.toString() ?? null,
    durationMin: r.durationMin ?? null,
    durationMax: r.durationMax ?? null,
    playCountMin: r.playCountMin ?? null,
    playCountMax: r.playCountMax ?? null,
    ratingMin: r.ratingMin ?? null,
    ratingMax: r.ratingMax ?? null,
    lastPlayedAtMin: dateOnly(r.lastPlayedAtMin),
    lastPlayedAtMax: dateOnly(r.lastPlayedAtMax),
    addedAtMin: dateOnly(r.addedAtMin),
    addedAtMax: dateOnly(r.addedAtMax),
    ...streamValues,
    // Stream count ranges
    audioStreamCountMin: sc?.audioCountMin ?? null,
    audioStreamCountMax: sc?.audioCountMax ?? null,
    subtitleStreamCountMin: sc?.subtitleCountMin ?? null,
    subtitleStreamCountMax: sc?.subtitleCountMax ?? null,
    ...streamQueryValues,
    ...crossSystem,
  };
}
