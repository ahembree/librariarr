import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { appCache } from "@/lib/cache/memory-cache";

import { normalizeResolutionLabel } from "@/lib/resolution";

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
function dedupeInsensitive(values: string[]): string[] {
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

const CACHE_KEY = "distinct-values";
const CACHE_TTL = 5 * 60_000; // 5 minutes — only changes on sync

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cached = appCache.get<Record<string, unknown>>(CACHE_KEY);
  if (cached) return NextResponse.json(cached);

  // Single-pass aggregation: all distinct values + min/max ranges in one query.
  // Genres require a separate query due to CROSS JOIN LATERAL on JSONB arrays.
  const [aggRows, genres, labelRows, countryRows, streamDistinct, streamCounts, sqDistinct, ruleSets, watchUsers] = await Promise.all([
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
    // Stream-level distinct values (languages, codecs)
    prisma.$queryRaw<{
      audioLanguages: string[] | null;
      subtitleLanguages: string[] | null;
      streamAudioCodecs: string[] | null;
    }[]>`
      SELECT
        array_agg(DISTINCT language) FILTER (WHERE language IS NOT NULL AND "streamType" = 2) AS "audioLanguages",
        array_agg(DISTINCT language) FILTER (WHERE language IS NOT NULL AND "streamType" = 3) AS "subtitleLanguages",
        array_agg(DISTINCT codec) FILTER (WHERE codec IS NOT NULL AND "streamType" = 2) AS "streamAudioCodecs"
      FROM "MediaStream"
    `,
    // Stream count ranges per item (audio, subtitle)
    prisma.$queryRaw<{
      audioCountMin: number | null;
      audioCountMax: number | null;
      subtitleCountMin: number | null;
      subtitleCountMax: number | null;
    }[]>`
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
    `,
    // Stream query distinct values (per-stream fields for stream query groups)
    prisma.$queryRaw<{
      codecs: string[] | null;
      profiles: string[] | null;
      languages: string[] | null;
      languageCodes: string[] | null;
      scanTypes: string[] | null;
      videoRangeTypes: string[] | null;
      audioLayouts: string[] | null;
      colorPrimaries: string[] | null;
      colorRanges: string[] | null;
      chromaSubsamplings: string[] | null;
    }[]>`
      SELECT
        array_agg(DISTINCT codec) FILTER (WHERE codec IS NOT NULL) AS codecs,
        array_agg(DISTINCT profile) FILTER (WHERE profile IS NOT NULL) AS profiles,
        array_agg(DISTINCT language) FILTER (WHERE language IS NOT NULL AND language != '' AND language != 'Unknown') AS languages,
        array_agg(DISTINCT "languageCode") FILTER (WHERE "languageCode" IS NOT NULL AND "languageCode" != '') AS "languageCodes",
        array_agg(DISTINCT "scanType") FILTER (WHERE "scanType" IS NOT NULL) AS "scanTypes",
        array_agg(DISTINCT "videoRangeType") FILTER (WHERE "videoRangeType" IS NOT NULL) AS "videoRangeTypes",
        array_agg(DISTINCT "audioChannelLayout") FILTER (WHERE "audioChannelLayout" IS NOT NULL) AS "audioLayouts",
        array_agg(DISTINCT "colorPrimaries") FILTER (WHERE "colorPrimaries" IS NOT NULL) AS "colorPrimaries",
        array_agg(DISTINCT "colorRange") FILTER (WHERE "colorRange" IS NOT NULL) AS "colorRanges",
        array_agg(DISTINCT "chromaSubsampling") FILTER (WHERE "chromaSubsampling" IS NOT NULL) AS "chromaSubsamplings"
      FROM "MediaStream"
    `,
    // Rule set names for cross-system "Matched By Rule Set" field
    prisma.ruleSet.findMany({
      where: { userId: session.userId },
      select: { name: true },
      orderBy: { name: "asc" },
    }),
    // Distinct server usernames from per-user watch history for the
    // `watchedByUser` field. Scoped via the user→server join to mirror the
    // ruleSets query above; under single-user this matches every server.
    prisma.$queryRaw<{ serverUsername: string }[]>`
      SELECT DISTINCT wh."serverUsername" AS "serverUsername"
      FROM "WatchHistory" wh
      JOIN "MediaServer" ms ON wh."mediaServerId" = ms.id
      WHERE ms."userId" = ${session.userId}
        AND wh."serverUsername" IS NOT NULL
        AND wh."serverUsername" != ''
      ORDER BY wh."serverUsername" ASC
    `,
  ]);

  const r = aggRows[0];
  const sd = streamDistinct[0];
  const sc = streamCounts[0];
  const sqd = sqDistinct[0];

  // Deduplicate genres (case-insensitive, keep first raw value)
  const genreMap = new Map<string, string>();
  for (const g of genres) {
    const key = g.genre.toLowerCase();
    if (!genreMap.has(key)) {
      genreMap.set(key, g.genre);
    }
  }

  // Deduplicate labels the same way as genres.
  const labelMap = new Map<string, string>();
  for (const l of labelRows) {
    const key = l.label.toLowerCase();
    if (!labelMap.has(key)) {
      labelMap.set(key, l.label);
    }
  }

  // Deduplicate countries the same way as genres.
  const countryMap = new Map<string, string>();
  for (const c of countryRows) {
    const key = c.country.toLowerCase();
    if (!countryMap.has(key)) {
      countryMap.set(key, c.country);
    }
  }

  const result = {
    resolution: STANDARD_RESOLUTIONS.filter((std) =>
      (r.resolutions ?? []).some((v) => normalizeResolutionLabel(v) === std)
    ),
    videoCodec: (r.videoCodecs ?? []).sort((a, b) => a.localeCompare(b)),
    audioCodec: (r.audioCodecs ?? []).sort((a, b) => a.localeCompare(b)),
    container: (r.containers ?? []).sort((a, b) => a.localeCompare(b)),
    dynamicRange: (r.dynamicRanges ?? []).sort((a, b) => dynamicRangeRank(b) - dynamicRangeRank(a)),
    audioProfile: (r.audioProfiles ?? []).sort((a, b) => a.localeCompare(b)),
    contentRating: (r.contentRatings ?? []).sort((a, b) => a.localeCompare(b)),
    studio: (r.studios ?? []).sort((a, b) => a.localeCompare(b)),
    genre: Array.from(genreMap.values()).sort((a, b) => a.localeCompare(b)),
    labels: Array.from(labelMap.values()).sort((a, b) => a.localeCompare(b)),
    country: Array.from(countryMap.values()).sort((a, b) => a.localeCompare(b)),
    year: (r.years ?? []).sort((a, b) => b - a),
    videoBitDepth: (r.videoBitDepths ?? []).sort((a, b) => b - a),
    videoProfile: (r.videoProfiles ?? []).sort((a, b) => a.localeCompare(b)),
    videoFrameRate: (r.videoFrameRates ?? []).sort((a, b) => a.localeCompare(b)),
    aspectRatio: (r.aspectRatios ?? []).sort((a, b) => a.localeCompare(b)),
    scanType: (r.scanTypes ?? []).sort((a, b) => a.localeCompare(b)),
    audioChannels: (r.audioChannelsArr ?? []).sort((a, b) => a - b),
    audioSamplingRate: (r.audioSamplingRates ?? []).sort((a, b) => a - b),
    fileSizeMin: r.fileSizeMin?.toString() ?? null,
    fileSizeMax: r.fileSizeMax?.toString() ?? null,
    durationMin: r.durationMin ?? null,
    durationMax: r.durationMax ?? null,
    playCountMin: r.playCountMin ?? null,
    playCountMax: r.playCountMax ?? null,
    ratingMin: r.ratingMin ?? null,
    ratingMax: r.ratingMax ?? null,
    lastPlayedAtMin: r.lastPlayedAtMin ? r.lastPlayedAtMin.toISOString().split("T")[0] : null,
    lastPlayedAtMax: r.lastPlayedAtMax ? r.lastPlayedAtMax.toISOString().split("T")[0] : null,
    addedAtMin: r.addedAtMin ? r.addedAtMin.toISOString().split("T")[0] : null,
    addedAtMax: r.addedAtMax ? r.addedAtMax.toISOString().split("T")[0] : null,
    // Stream-level distinct values
    audioLanguage: dedupeInsensitive(sd?.audioLanguages ?? []).sort((a, b) => a.localeCompare(b)),
    subtitleLanguage: dedupeInsensitive(sd?.subtitleLanguages ?? []).sort((a, b) => a.localeCompare(b)),
    streamAudioCodec: dedupeInsensitive(sd?.streamAudioCodecs ?? []).sort((a, b) => a.localeCompare(b)),
    // Stream count ranges
    audioStreamCountMin: sc?.audioCountMin ?? null,
    audioStreamCountMax: sc?.audioCountMax ?? null,
    subtitleStreamCountMin: sc?.subtitleCountMin ?? null,
    subtitleStreamCountMax: sc?.subtitleCountMax ?? null,
    // Stream query distinct values (per-stream fields)
    sqCodec: dedupeInsensitive(sqd?.codecs ?? []).sort((a, b) => a.localeCompare(b)),
    sqProfile: dedupeInsensitive(sqd?.profiles ?? []).sort((a, b) => a.localeCompare(b)),
    sqLanguage: dedupeInsensitive(sqd?.languages ?? []).sort((a, b) => a.localeCompare(b)),
    sqLanguageCode: dedupeInsensitive(sqd?.languageCodes ?? []).sort((a, b) => a.localeCompare(b)),
    sqScanType: dedupeInsensitive(sqd?.scanTypes ?? []).sort((a, b) => a.localeCompare(b)),
    sqVideoRangeType: dedupeInsensitive(sqd?.videoRangeTypes ?? []).sort((a, b) => a.localeCompare(b)),
    sqAudioLayout: dedupeInsensitive(sqd?.audioLayouts ?? []).sort((a, b) => a.localeCompare(b)),
    sqColorPrimaries: dedupeInsensitive(sqd?.colorPrimaries ?? []).sort((a, b) => a.localeCompare(b)),
    sqColorRange: dedupeInsensitive(sqd?.colorRanges ?? []).sort((a, b) => a.localeCompare(b)),
    sqChromaSubsampling: dedupeInsensitive(sqd?.chromaSubsamplings ?? []).sort((a, b) => a.localeCompare(b)),
    // Cross-system distinct values
    matchedByRuleSet: ruleSets.map((rs) => rs.name),
    // Per-user watch history — usernames who have ever played a media item.
    watchedByUser: watchUsers.map((u) => u.serverUsername),
  };

  appCache.set(CACHE_KEY, result, CACHE_TTL);
  return NextResponse.json(result);
}
