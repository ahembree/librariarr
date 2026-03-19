import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { appCache } from "@/lib/cache/memory-cache";
import { normalizeResolutionLabel } from "@/lib/resolution";

const STANDARD_RESOLUTIONS = ["4K", "1080P", "720P", "480P", "SD", "Other"];

const CACHE_KEY = "query-distinct-values";
const CACHE_TTL = 5 * 60_000;

/** Deduplicate strings case-insensitively, preferring the title-cased variant. */
function dedupeInsensitive(values: string[]): string[] {
  const map = new Map<string, string>();
  for (const v of values) {
    const key = v.toLowerCase();
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
}

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cached = appCache.get<Record<string, unknown>>(CACHE_KEY);
  if (cached) return NextResponse.json(cached);

  const [aggRows, genres, streamDistinct, sqDistinct, ruleSets] = await Promise.all([
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
        array_agg(DISTINCT "audioSamplingRate") FILTER (WHERE "audioSamplingRate" IS NOT NULL) AS "audioSamplingRates"
      FROM "MediaItem"
    `,
    prisma.$queryRaw<{ genre: string }[]>`
      SELECT DISTINCT g.genre AS "genre"
      FROM "MediaItem" mi
      CROSS JOIN LATERAL jsonb_array_elements_text(mi.genres) AS g(genre)
      WHERE mi.genres IS NOT NULL AND jsonb_typeof(mi.genres) = 'array'
      ORDER BY g.genre
    `,
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
    // Stream query distinct values (per-stream fields)
    prisma.$queryRaw<{
      codecs: string[] | null;
      profiles: string[] | null;
      languages: string[] | null;
      languageCodes: string[] | null;
      sqScanTypes: string[] | null;
      videoRangeTypes: string[] | null;
      audioLayouts: string[] | null;
    }[]>`
      SELECT
        array_agg(DISTINCT codec) FILTER (WHERE codec IS NOT NULL) AS codecs,
        array_agg(DISTINCT profile) FILTER (WHERE profile IS NOT NULL) AS profiles,
        array_agg(DISTINCT language) FILTER (WHERE language IS NOT NULL AND language != '' AND language != 'Unknown') AS languages,
        array_agg(DISTINCT "languageCode") FILTER (WHERE "languageCode" IS NOT NULL) AS "languageCodes",
        array_agg(DISTINCT "scanType") FILTER (WHERE "scanType" IS NOT NULL) AS "sqScanTypes",
        array_agg(DISTINCT "videoRangeType") FILTER (WHERE "videoRangeType" IS NOT NULL) AS "videoRangeTypes",
        array_agg(DISTINCT "audioChannelLayout") FILTER (WHERE "audioChannelLayout" IS NOT NULL) AS "audioLayouts"
      FROM "MediaStream"
    `,
    // Rule set names for cross-system "Matched By Rule Set" field
    prisma.ruleSet.findMany({
      where: { userId: session.userId },
      select: { name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const r = aggRows[0];
  const sd = streamDistinct[0];
  const sqd = sqDistinct[0];

  // Deduplicate genres
  const genreMap = new Map<string, string>();
  for (const g of genres) {
    const key = g.genre.toLowerCase();
    if (!genreMap.has(key)) {
      genreMap.set(key, g.genre);
    }
  }

  const result = {
    resolution: STANDARD_RESOLUTIONS.filter((std) =>
      (r.resolutions ?? []).some((v) => normalizeResolutionLabel(v) === std)
    ),
    videoCodec: (r.videoCodecs ?? []).sort((a, b) => a.localeCompare(b)),
    audioCodec: (r.audioCodecs ?? []).sort((a, b) => a.localeCompare(b)),
    container: (r.containers ?? []).sort((a, b) => a.localeCompare(b)),
    dynamicRange: (r.dynamicRanges ?? []).sort((a, b) => a.localeCompare(b)),
    audioProfile: (r.audioProfiles ?? []).sort((a, b) => a.localeCompare(b)),
    contentRating: (r.contentRatings ?? []).sort((a, b) => a.localeCompare(b)),
    studio: (r.studios ?? []).sort((a, b) => a.localeCompare(b)),
    genre: Array.from(genreMap.values()).sort((a, b) => a.localeCompare(b)),
    year: (r.years ?? []).sort((a, b) => b - a),
    videoBitDepth: (r.videoBitDepths ?? []).sort((a, b) => b - a),
    videoProfile: (r.videoProfiles ?? []).sort((a, b) => a.localeCompare(b)),
    videoFrameRate: (r.videoFrameRates ?? []).sort((a, b) => a.localeCompare(b)),
    aspectRatio: (r.aspectRatios ?? []).sort((a, b) => a.localeCompare(b)),
    scanType: (r.scanTypes ?? []).sort((a, b) => a.localeCompare(b)),
    audioChannels: (r.audioChannelsArr ?? []).sort((a, b) => a - b),
    audioSamplingRate: (r.audioSamplingRates ?? []).sort((a, b) => a - b),
    audioLanguage: dedupeInsensitive(sd?.audioLanguages ?? []).sort((a, b) => a.localeCompare(b)),
    subtitleLanguage: dedupeInsensitive(sd?.subtitleLanguages ?? []).sort((a, b) => a.localeCompare(b)),
    streamAudioCodec: dedupeInsensitive(sd?.streamAudioCodecs ?? []).sort((a, b) => a.localeCompare(b)),
    // Stream query distinct values
    sqCodec: dedupeInsensitive(sqd?.codecs ?? []).sort((a, b) => a.localeCompare(b)),
    sqProfile: dedupeInsensitive(sqd?.profiles ?? []).sort((a, b) => a.localeCompare(b)),
    sqLanguage: dedupeInsensitive(sqd?.languages ?? []).sort((a, b) => a.localeCompare(b)),
    sqLanguageCode: dedupeInsensitive(sqd?.languageCodes ?? []).sort((a, b) => a.localeCompare(b)),
    sqScanType: dedupeInsensitive(sqd?.sqScanTypes ?? []).sort((a, b) => a.localeCompare(b)),
    sqVideoRangeType: dedupeInsensitive(sqd?.videoRangeTypes ?? []).sort((a, b) => a.localeCompare(b)),
    sqAudioLayout: dedupeInsensitive(sqd?.audioLayouts ?? []).sort((a, b) => a.localeCompare(b)),
    // Cross-system distinct values
    matchedByRuleSet: ruleSets.map((rs) => rs.name),
  };

  appCache.set(CACHE_KEY, result, CACHE_TTL);
  return NextResponse.json(result);
}
