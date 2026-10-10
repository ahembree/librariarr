import { prisma } from "@/lib/db";
import { resolveServerFilter } from "@/lib/dedup/server-filter";
import { CONDITION_FIELDS } from "@/lib/conditions/fields";
import { fetchCrossSystemData, type CrossSystemDataEntry } from "@/lib/conditions/cross-system-data";
import {
  aggregateEpisodesIntoSeries,
  serializeSeriesAggregateForEval,
  type AggregableEpisode,
} from "@/lib/conditions/series-aggregates";
import { COMPLETED_PLAY_FILTER } from "@/lib/media/watch-completion";
import { lookupSeerrMeta } from "@/lib/rules/lifecycle-engine";
import type { ArrDataMap, ArrMetadata, SeerrDataMap, SeerrMetadata } from "@/lib/rules/lifecycle-engine";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import { logger } from "@/lib/logger";
import { fetchArrDataForQuery } from "./fetch-arr-data";
import { fetchSeerrDataForQuery } from "./fetch-seerr-data";
import { QUERY_COLUMN_FIELDS, type QueryColumnValue } from "./column-fields";

/**
 * Values for the Query page's criterion columns: any field a query can filter
 * on can also be shown as a column. Computed on demand for the rows already on
 * screen rather than inside `executeQuery`, so adding a column never re-runs
 * the query, and a query nobody shows extra columns for pays nothing.
 *
 * Values are raw (numbers, ISO dates, booleans, string lists) so the table can
 * sort them; formatting is the client's job. `null` means "no value" — and
 * also "not answerable here" (no Arr instance selected, Seerr unreachable),
 * which `warnings` then explains.
 */

export interface ColumnValueRequestItem {
  id: string;
  /** A grouped series row (one row per show): values come from the show's aggregate. */
  grouped?: boolean;
}

export interface ColumnValuesResult {
  values: Record<string, Record<string, QueryColumnValue>>;
  warnings: string[];
}

const FIELD_DEFS = new Map(CONDITION_FIELDS.map((f) => [f.value, f]));
const CHUNK = 1000;

/**
 * Episode-level detail a grouped series row has no single answer for. The
 * table's own video/audio/file columns already show "-" on a show row. The
 * stream counts would otherwise total every episode's tracks ("80 audio
 * tracks" for a 40-episode show); the language lists stay, as a union.
 */
const EPISODE_ONLY_SECTIONS = new Set(["video", "audio", "file"]);
const EPISODE_ONLY_FIELDS = new Set([
  "parentTitle", "albumTitle", "originallyAvailableAt", "audioStreamCount", "subtitleStreamCount",
]);

const ARR_PROPERTY: Record<string, keyof ArrMetadata> = {
  arrMonitored: "monitored",
  arrTag: "tags",
  arrQualityProfile: "qualityProfile",
  arrQualityName: "qualityName",
  arrQualityCutoffMet: "qualityCutoffMet",
  arrCustomFormatScore: "customFormatScore",
  arrStatus: "status",
  arrEnded: "ended",
  arrSeriesType: "seriesType",
  arrRating: "rating",
  arrTmdbRating: "tmdbRating",
  arrRtCriticRating: "rtCriticRating",
  arrOriginalLanguage: "originalLanguage",
  arrRuntime: "runtime",
  arrSizeOnDisk: "sizeOnDisk",
  arrPath: "path",
  arrReleaseDate: "releaseDate",
  arrInCinemasDate: "inCinemasDate",
  arrFirstAired: "firstAired",
  arrDateAdded: "dateAdded",
  arrDownloadDate: "downloadDate",
  arrSeasonCount: "seasonCount",
  arrEpisodeCount: "episodeCount",
  arrHasUnaired: "hasUnaired",
  arrMonitoredSeasonCount: "monitoredSeasonCount",
  arrMonitoredEpisodeCount: "monitoredEpisodeCount",
};

const SEERR_PROPERTY: Record<string, keyof SeerrMetadata> = {
  seerrRequested: "requested",
  seerrRequestDate: "requestDate",
  seerrRequestCount: "requestCount",
  seerrRequestedBy: "requestedBy",
  seerrApprovalDate: "approvalDate",
  seerrDeclineDate: "declineDate",
};

/** Fields read straight off the row (or the series aggregate) by name. */
const DIRECT_FIELDS = new Set([
  "title", "parentTitle", "albumTitle", "year", "contentRating", "studio",
  "playCount", "rating", "audienceRating", "ratingCount", "isWatchlisted",
  "lastPlayedAt", "addedAt", "originallyAvailableAt",
  "resolution", "videoCodec", "videoProfile", "dynamicRange", "videoBitDepth",
  "videoBitrate", "videoFrameRate", "aspectRatio", "scanType",
  "audioCodec", "audioProfile", "audioChannels", "audioSamplingRate", "audioBitrate",
  "container", "duration",
  "latestEpisodeViewDate", "seriesLastPlayedAt", "availableEpisodeCount",
  "watchedEpisodeCount", "watchedEpisodePercentage", "lastEpisodeAddedAt", "lastEpisodeAiredAt",
]);

const ARRAY_COLUMN: Record<string, string> = { genre: "genres", labels: "labels", country: "countries" };

/** Every field this module can answer — pinned to CONDITION_FIELDS by a unit test. */
export function isColumnFieldHandled(field: string): boolean {
  return DIRECT_FIELDS.has(field) || field in ARR_PROPERTY || field in SEERR_PROPERTY ||
    field in ARRAY_COLUMN || field === "foundInArr" || field === "fileSize" ||
    field === "hasExternalId" || field === "watchedByUser" ||
    field === "audioLanguage" || field === "subtitleLanguage" || field === "streamAudioCodec" ||
    field === "audioStreamCount" || field === "subtitleStreamCount" ||
    field === "serverCount" || field === "matchedByRuleSet" || field === "hasPendingAction";
}

function normalize(v: unknown): QueryColumnValue {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(String);
  return String(v);
}

interface StreamRow { streamType: number; language: string | null; codec: string | null }

function streamValues(streams: StreamRow[], streamType: number, key: "language" | "codec", isLanguage: boolean): string[] {
  return [...new Set(
    streams
      .filter((s) => s.streamType === streamType)
      .map((s) => s[key] ?? "")
      .filter((v) => v !== "" && (!isLanguage || v.toLowerCase() !== "unknown")),
  )];
}

/** One field's value for one item. Exported for unit tests. */
export function columnValueOf(
  field: string,
  item: Record<string, unknown>,
  ctx: {
    arrMeta?: ArrMetadata;
    /** Arr data was fetched for this item's type (so a missing record means "not in Arr"). */
    arrLoaded: boolean;
    seerrMeta?: SeerrMetadata;
    seerrLoaded: boolean;
    cross?: CrossSystemDataEntry;
  },
): QueryColumnValue {
  if (field === "foundInArr") return ctx.arrLoaded ? ctx.arrMeta !== undefined : null;
  if (field in ARR_PROPERTY) {
    return ctx.arrMeta ? normalize(ctx.arrMeta[ARR_PROPERTY[field]]) : null;
  }
  if (field in SEERR_PROPERTY) {
    if (!ctx.seerrLoaded) return null;
    const meta: SeerrMetadata = ctx.seerrMeta ?? {
      requested: false, requestCount: 0, requestDate: null,
      requestedBy: [], approvalDate: null, declineDate: null,
    };
    return normalize(meta[SEERR_PROPERTY[field]]);
  }
  if (field === "serverCount") return ctx.cross?.serverCount ?? null;
  if (field === "matchedByRuleSet") return ctx.cross ? [...ctx.cross.matchedRuleSets] : null;
  if (field === "hasPendingAction") return ctx.cross?.hasPendingAction ?? null;

  if (field in ARRAY_COLUMN) {
    const arr = item[ARRAY_COLUMN[field]];
    return Array.isArray(arr) ? arr.map(String) : [];
  }
  if (field === "hasExternalId") {
    const ids = (item.externalIds as Array<{ source: string; externalId: string }> | undefined) ?? [];
    return ids.map((e) => `${e.source}:${e.externalId}`);
  }
  if (field === "watchedByUser") {
    if (Array.isArray(item.watchedByUsers)) return [...(item.watchedByUsers as string[])];
    const history = (item.watchHistory as Array<{ serverUsername: string | null }> | undefined) ?? [];
    return [...new Set(history.map((h) => h.serverUsername).filter((u): u is string => !!u))];
  }

  const streams = (item.streams as StreamRow[] | undefined) ?? [];
  if (field === "audioLanguage") return streamValues(streams, 2, "language", true);
  if (field === "subtitleLanguage") return streamValues(streams, 3, "language", true);
  if (field === "streamAudioCodec") return streamValues(streams, 2, "codec", false);
  if (field === "audioStreamCount") return streams.filter((s) => s.streamType === 2).length;
  if (field === "subtitleStreamCount") return streams.filter((s) => s.streamType === 3).length;

  if (field === "fileSize") {
    const v = item.fileSize;
    return v == null ? null : Number(v);
  }
  if (DIRECT_FIELDS.has(field)) return normalize(item[field]);
  return null;
}

const ITEM_SELECT = {
  id: true, type: true, title: true, parentTitle: true, albumTitle: true, seriesKey: true,
  year: true, contentRating: true, studio: true, genres: true, labels: true, countries: true,
  playCount: true, rating: true, audienceRating: true, ratingCount: true, isWatchlisted: true,
  lastPlayedAt: true, addedAt: true, originallyAvailableAt: true,
  resolution: true, videoCodec: true, videoProfile: true, dynamicRange: true, videoBitDepth: true,
  videoBitrate: true, videoFrameRate: true, aspectRatio: true, scanType: true,
  audioCodec: true, audioProfile: true, audioChannels: true, audioSamplingRate: true, audioBitrate: true,
  container: true, duration: true, fileSize: true,
  libraryId: true, seasonNumber: true, episodeNumber: true, summary: true, parentSummary: true,
  streams: { select: { streamType: true, language: true, codec: true } },
  externalIds: { select: { source: true, externalId: true } },
} as const;

function selectFor(withHistory: boolean) {
  return withHistory
    ? { ...ITEM_SELECT, watchHistory: { where: COMPLETED_PLAY_FILTER, select: { serverUsername: true } } }
    : ITEM_SELECT;
}

async function findInChunks(
  ids: string[],
  where: Record<string, unknown>,
  withHistory: boolean,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await prisma.mediaItem.findMany({
      where: { ...where, id: { in: ids.slice(i, i + CHUNK) } },
      select: selectFor(withHistory),
    });
    out.push(...(rows as unknown as Array<Record<string, unknown>>));
  }
  return out;
}

export async function computeQueryColumnValues(
  userId: string,
  opts: {
    items: ColumnValueRequestItem[];
    fields: string[];
    serverIds: string[];
    arrServerIds?: { radarr?: string; sonarr?: string; lidarr?: string };
  },
): Promise<ColumnValuesResult> {
  const fields = [...new Set(opts.fields)].filter((f) => QUERY_COLUMN_FIELDS.has(f));
  const values: Record<string, Record<string, QueryColumnValue>> = {};
  const warnings: string[] = [];
  if (fields.length === 0 || opts.items.length === 0) return { values, warnings };

  const sf = await resolveServerFilter(userId, null);
  if (!sf) return { values, warnings };
  const serverIds = opts.serverIds.length > 0
    ? sf.serverIds.filter((id) => opts.serverIds.includes(id))
    : sf.serverIds;
  if (serverIds.length === 0) return { values, warnings };
  const scope = { library: { mediaServerId: { in: serverIds } } };

  const withHistory = fields.includes("watchedByUser");
  const ids = [...new Set(opts.items.map((i) => i.id))];
  const groupedIds = new Set(opts.items.filter((i) => i.grouped).map((i) => i.id));
  const rows = await findInChunks(ids, scope, withHistory);
  // Nothing in scope: return before the Arr/Seerr fetches, which read an empty
  // type list as "every type".
  if (rows.length === 0) return { values, warnings };
  const byId = new Map(rows.map((r) => [r.id as string, r]));

  // Grouped series rows: answer from the show's aggregate over every one of
  // its episodes in the representative's library — the same per-library
  // record the query engine evaluates series rules against.
  const evalItems = new Map<string, Record<string, unknown>>();
  const groupedRows = rows.filter((r) => groupedIds.has(r.id as string) && r.type === "SERIES" && r.seriesKey);
  if (groupedRows.length > 0) {
    const keys = [...new Set(groupedRows.map((r) => r.seriesKey as string))];
    const libraryIds = [...new Set(groupedRows.map((r) => r.libraryId as string))];
    const episodes: Array<Record<string, unknown>> = [];
    for (let i = 0; i < keys.length; i += CHUNK) {
      const chunk = await prisma.mediaItem.findMany({
        where: { ...scope, type: "SERIES", libraryId: { in: libraryIds }, seriesKey: { in: keys.slice(i, i + CHUNK) } },
        select: selectFor(withHistory),
      });
      episodes.push(...(chunk as unknown as Array<Record<string, unknown>>));
    }
    const aggregates = aggregateEpisodesIntoSeries(episodes as unknown as AggregableEpisode[], { includeStreams: true });
    const byMember = new Map<string, Record<string, unknown>>();
    for (const agg of aggregates) {
      const serialized = serializeSeriesAggregateForEval(agg);
      for (const memberId of agg.memberIds) byMember.set(memberId, serialized);
    }
    for (const row of groupedRows) {
      const agg = byMember.get(row.id as string);
      if (agg) evalItems.set(row.id as string, agg);
    }
  }

  const fieldDefs = fields.map((f) => FIELD_DEFS.get(f)!);
  const types = [...new Set(rows.map((r) => r.type as string))];

  let cross: Map<string, CrossSystemDataEntry> | undefined;
  if (fieldDefs.some((f) => f.section === "cross")) {
    cross = await fetchCrossSystemData(ids.filter((id) => byId.has(id)));
  }

  let arrByType: Record<string, ArrDataMap> = {};
  if (fieldDefs.some((f) => f.requiresArr)) {
    const arrServerIds = opts.arrServerIds ?? {};
    if (!arrServerIds.radarr && !arrServerIds.sonarr && !arrServerIds.lidarr) {
      warnings.push("Select an Arr server in the query scope to show Arr columns.");
    } else {
      try {
        arrByType = await fetchArrDataForQuery(userId, arrServerIds, types);
      } catch (error) {
        logger.warn("Query", "Arr data for query columns could not be fetched", { error: String(error) });
        warnings.push(`Arr columns are empty: ${sanitizeErrorDetail(error instanceof Error ? error.message : String(error))}`);
      }
    }
  }

  let seerrByType: Record<string, SeerrDataMap> = {};
  let seerrLoaded = false;
  // Seerr holds only movies and shows; music rows read null either way.
  const seerrTypes = types.filter((t) => t !== "MUSIC");
  if (fieldDefs.some((f) => f.requiresSeerr) && seerrTypes.length > 0) {
    try {
      seerrByType = await fetchSeerrDataForQuery(userId, seerrTypes);
      seerrLoaded = true;
    } catch (error) {
      logger.warn("Query", "Seerr data for query columns could not be fetched", { error: String(error) });
      warnings.push(`Seerr columns are empty: ${sanitizeErrorDetail(error instanceof Error ? error.message : String(error))}`);
    }
  }

  for (const row of rows) {
    const id = row.id as string;
    const grouped = groupedIds.has(id);
    const item = evalItems.get(id) ?? row;
    const type = row.type as string;
    const externalIds = (row.externalIds as Array<{ source: string; externalId: string }>) ?? [];
    const arrSource = type === "MOVIE" ? "TMDB" : type === "MUSIC" ? "MUSICBRAINZ" : "TVDB";
    const arrData = arrByType[type];
    const arrExtId = externalIds.find((e) => e.source === arrSource);
    const ctx = {
      arrMeta: arrData && arrExtId ? arrData[arrExtId.externalId] : undefined,
      arrLoaded: !!arrData,
      seerrMeta: type === "MUSIC" ? undefined : lookupSeerrMeta(externalIds, seerrByType[type], type),
      seerrLoaded: seerrLoaded && type !== "MUSIC",
      cross: cross?.get(id),
    };
    const out: Record<string, QueryColumnValue> = {};
    for (const def of fieldDefs) {
      if (def.invalidForLibraryType?.includes(type as "MOVIE" | "SERIES" | "MUSIC") ||
          (def.isSeriesAggregate && !evalItems.has(id)) ||
          (grouped && (EPISODE_ONLY_SECTIONS.has(def.section) || EPISODE_ONLY_FIELDS.has(def.value)))) {
        out[def.value] = null;
        continue;
      }
      out[def.value] = columnValueOf(def.value, item, ctx);
    }
    values[id] = out;
  }

  return { values, warnings };
}
