import { resolveStatsScope, type StatsScope } from "@/lib/media/stats-scope";
import { computeLibraryStats } from "@/lib/media/library-stats";
import { computeBreakdown } from "@/lib/media/breakdown";
import { computeCrossTab } from "@/lib/media/cross-tab";
import {
  computeTimeline,
  ALLOWED_DATE_COLUMNS,
  VALID_BINS,
  VALID_MEASURES,
} from "@/lib/media/timeline";
import { computeWatchTrends, computeWatchLeaderboard } from "@/lib/media/watch-analytics";
import { DIMENSION_REGISTRY, getDimensionMeta, DATE_DIMENSION_IDS } from "@/lib/dashboard/custom-dimensions";
import { executeQuery } from "@/lib/query/query-engine";
import type { QueryDefinition } from "@/lib/query/types";
import { CONDITION_FIELDS, CONDITION_OPERATORS } from "@/lib/conditions";
import type { AiTool, AiToolResult } from "./types";

const MEDIA_TYPES = ["MOVIE", "SERIES", "MUSIC"] as const;
const DIMENSION_IDS = DIMENSION_REGISTRY.map((d) => d.id);
const OPERATOR_VALUES = new Set<string>(CONDITION_OPERATORS.map((o) => o.value));
const VALUELESS_OPERATORS = new Set(["isNull", "isNotNull"]);

// Search is restricted to fields that need no external service. Arr/Seerr fields
// are deliberately excluded: without wiring the Arr/Seerr metadata fetch they'd
// evaluate against an empty map and vacuously match — the exact hazard the
// lifecycle evaluability guard exists to prevent. Series-aggregate fields are
// allowed (the query engine routes them correctly).
export const SEARCH_FIELDS = CONDITION_FIELDS.filter((f) => !f.requiresArr && !f.requiresSeerr);
const SEARCH_FIELD_SET = new Set(SEARCH_FIELDS.map((f) => f.value));

const NO_SERVERS = { data: { note: "No media servers are connected yet, so there's nothing to analyze." } };

async function scope(userId: string): Promise<StatsScope | null> {
  const s = await resolveStatsScope(userId);
  if (s === "server-not-found" || s.serverIds.length === 0) return null;
  return s;
}

function gb(bytesStr: string | bigint | null | undefined): number {
  const n = typeof bytesStr === "bigint" ? Number(bytesStr) : Number(bytesStr ?? 0);
  return Math.round((n / 1_000_000_000) * 100) / 100;
}

type BreakdownRow = { value: string | null; type: string; _count: number };

/** Sum a per-(value,type) breakdown into per-value totals, top N desc. */
function aggregateByValue(rows: BreakdownRow[], mediaType: string | undefined, topN: number) {
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (mediaType && r.type !== mediaType) continue;
    const value = r.value ?? "Unknown";
    totals.set(value, (totals.get(value) ?? 0) + r._count);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([value, count]) => ({ value, count }));
}

function clampInt(value: unknown, def: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ─── Tools ──────────────────────────────────────────────────────────────

const getLibraryOverview: AiTool = {
  definition: {
    name: "get_library_overview",
    description:
      "High-level snapshot of the whole library: item counts (movies, series, seasons, episodes, artists, albums, tracks), total and per-type storage in GB, top resolutions / video codecs / genres, and the most-played titles by cumulative play count. Use this first for broad 'what's in my library' or summary questions.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  async execute(userId) {
    const s = await scope(userId);
    if (!s) return NO_SERVERS;
    const stats = await computeLibraryStats(s.serverIds, s.dedupEnabled);
    const data = {
      counts: {
        movies: stats.movieCount,
        series: stats.seriesCount,
        seasons: stats.seasonCount,
        episodes: stats.episodeCount,
        artists: stats.artistCount,
        albums: stats.albumCount,
        tracks: stats.musicCount,
      },
      storageGB: {
        total: gb(stats.totalSize),
        movies: gb(stats.movieSize),
        series: gb(stats.seriesSize),
        music: gb(stats.musicSize),
      },
      topResolutions: aggregateByValue(
        stats.qualityBreakdown.map((r) => ({ value: r.resolution, type: r.type, _count: r._count })),
        undefined,
        8,
      ),
      topVideoCodecs: aggregateByValue(
        stats.videoCodecBreakdown.map((r) => ({ value: r.videoCodec, type: r.type, _count: r._count })),
        undefined,
        8,
      ),
      topGenres: (stats.genreBreakdown as { value: string; _count: number }[])
        .slice(0, 10)
        .map((g) => ({ value: g.value, count: g._count })),
      topPlayedMovies: stats.topMovies.map((m) => ({ title: m.title, plays: m.playCount })),
      topPlayedSeries: stats.topSeries.map((s2) => ({ title: s2.parentTitle, plays: s2.totalPlays })),
    };
    return {
      data,
      evidence: { tool: "get_library_overview", kind: "overview", title: "Library overview", data },
    };
  },
};

const getBreakdown: AiTool = {
  definition: {
    name: "get_breakdown",
    description:
      "Distribution of the library across ONE dimension (e.g. how many items per resolution, video codec, genre, studio, year, container, audio channels, file-size bucket, etc.). Also the way to discover the actual values that exist for a dimension before filtering with search_media.",
    parameters: {
      type: "object",
      properties: {
        dimension: { type: "string", enum: DIMENSION_IDS, description: "Which dimension to break down by." },
        mediaType: { type: "string", enum: [...MEDIA_TYPES], description: "Optional: restrict to one media type." },
      },
      required: ["dimension"],
      additionalProperties: false,
    },
  },
  async execute(userId, args) {
    const meta = getDimensionMeta(String(args.dimension ?? ""));
    if (!meta) return { data: { error: `Unknown dimension. Valid: ${DIMENSION_IDS.join(", ")}` } };
    const s = await scope(userId);
    if (!s) return NO_SERVERS;
    const mediaType = MEDIA_TYPES.includes(args.mediaType as (typeof MEDIA_TYPES)[number])
      ? (args.mediaType as string)
      : undefined;
    const rows = (await computeBreakdown(meta, s.serverIds, s.dedupEnabled)) as BreakdownRow[];
    const agg = aggregateByValue(rows, mediaType, 50);
    const data = { dimension: meta.label, rows: agg };
    return {
      data,
      evidence: { tool: "get_breakdown", kind: "breakdown", title: `${meta.label} distribution`, data },
    };
  },
};

const getCrossTab: AiTool = {
  definition: {
    name: "get_cross_tab",
    description:
      "Cross-tabulate TWO dimensions to find relationships/patterns between them (e.g. resolution × video codec, dynamic range × audio channels). Returns counts for each combination. Use this for 'is there a pattern between X and Y' questions.",
    parameters: {
      type: "object",
      properties: {
        dimension1: { type: "string", enum: DIMENSION_IDS },
        dimension2: { type: "string", enum: DIMENSION_IDS },
      },
      required: ["dimension1", "dimension2"],
      additionalProperties: false,
    },
  },
  async execute(userId, args) {
    const meta1 = getDimensionMeta(String(args.dimension1 ?? ""));
    const meta2 = getDimensionMeta(String(args.dimension2 ?? ""));
    if (!meta1 || !meta2) return { data: { error: `Unknown dimension. Valid: ${DIMENSION_IDS.join(", ")}` } };
    if (meta1.id === meta2.id) return { data: { error: "The two dimensions must be different." } };
    if (meta1.category === "stream_group" && meta2.category === "stream_group") {
      return { data: { error: "Cannot cross two stream dimensions (audio/subtitle language)." } };
    }
    const s = await scope(userId);
    if (!s) return NO_SERVERS;
    const raw = await computeCrossTab(meta1, meta2, s.serverIds, s.dedupEnabled);
    const totals = new Map<string, { dim1: string; dim2: string; count: number }>();
    for (const r of raw) {
      const dim1 = r.dim1 ?? "Unknown";
      const dim2 = r.dim2 ?? "Unknown";
      const key = `${dim1} ${dim2}`;
      const cur = totals.get(key);
      if (cur) cur.count += r._count;
      else totals.set(key, { dim1, dim2, count: r._count });
    }
    const rows = [...totals.values()].sort((a, b) => b.count - a.count).slice(0, 300);
    const data = { dimension1: meta1.label, dimension2: meta2.label, rows };
    return {
      data,
      evidence: { tool: "get_cross_tab", kind: "cross_tab", title: `${meta1.label} × ${meta2.label}`, data },
    };
  },
};

const getTimeline: AiTool = {
  definition: {
    name: "get_timeline",
    description:
      "Time series of the library binned by date — how the collection grew (dateField=addedAt), what was released over time (originallyAvailableAt), or when things were last played (lastPlayedAt). measure=count (items) or size (storage). Optional breakdown dimension splits each bucket into series.",
    parameters: {
      type: "object",
      properties: {
        dateField: { type: "string", enum: [...ALLOWED_DATE_COLUMNS], description: "Which date to bucket by." },
        bin: { type: "string", enum: [...VALID_BINS], description: "Bucket granularity (default month)." },
        measure: { type: "string", enum: [...VALID_MEASURES], description: "count (items) or size (bytes). Default count." },
        mediaType: { type: "string", enum: [...MEDIA_TYPES], description: "Optional: restrict to one media type." },
        breakdown: { type: "string", enum: DIMENSION_IDS, description: "Optional: split each bucket by this dimension." },
        topN: { type: "number", description: "Optional: keep only the top-N breakdown series (rest → 'Other')." },
      },
      required: ["dateField"],
      additionalProperties: false,
    },
  },
  async execute(userId, args) {
    const dateField = String(args.dateField ?? "");
    if (!ALLOWED_DATE_COLUMNS.has(dateField)) {
      return { data: { error: `Invalid dateField. Valid: ${[...ALLOWED_DATE_COLUMNS].join(", ")}` } };
    }
    const bin = VALID_BINS.has(String(args.bin ?? "")) ? String(args.bin) : "month";
    const measure = VALID_MEASURES.has(String(args.measure ?? "")) ? String(args.measure) : "count";
    const mediaType = MEDIA_TYPES.includes(args.mediaType as (typeof MEDIA_TYPES)[number])
      ? (args.mediaType as string)
      : null;
    let breakdownMeta = null;
    if (args.breakdown) {
      breakdownMeta = getDimensionMeta(String(args.breakdown));
      if (!breakdownMeta) return { data: { error: `Unknown breakdown dimension.` } };
      if (DATE_DIMENSION_IDS.has(breakdownMeta.id)) {
        return { data: { error: "Cannot use a date dimension as the breakdown." } };
      }
    }
    const s = await scope(userId);
    if (!s) return NO_SERVERS;
    const result = await computeTimeline({
      dateField,
      bin,
      measure,
      breakdownMeta,
      serverIds: s.serverIds,
      typeFilter: mediaType,
      topN: typeof args.topN === "number" ? clampInt(args.topN, 8, 1, 20) : null,
      dedupEnabled: s.dedupEnabled,
    });
    // Cap points fed to the model / UI.
    const points = result.points.slice(-400);
    const data = { dateField, bin, measure, series: result.series, points };
    return {
      data,
      evidence: { tool: "get_timeline", kind: "timeline", title: `Timeline by ${dateField}`, data },
    };
  },
};

const searchMedia: AiTool = {
  definition: {
    name: "search_media",
    description:
      "Find specific items by filtering on library metadata, and rank/limit them. Use for 'find X', 'largest files' (sortBy fileSize desc), 'never watched' (playCount equals 0), 'not played in a year' (lastPlayedAt notInLastDays 365), 'missing metadata' (hasExternalId isNull), etc. Combine filters with match=all (AND) or any (OR). Discover valid values for enumerable fields via get_breakdown first.",
    parameters: {
      type: "object",
      properties: {
        mediaTypes: { type: "array", items: { type: "string", enum: [...MEDIA_TYPES] }, description: "Restrict to these media types (default all)." },
        filters: {
          type: "array",
          description: "Conditions. Each is {field, operator, value}. value is omitted for isNull/isNotNull.",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              operator: { type: "string" },
              value: {},
            },
            required: ["field", "operator"],
            additionalProperties: false,
          },
        },
        match: { type: "string", enum: ["all", "any"], description: "Combine filters with AND (all) or OR (any). Default all." },
        sortBy: { type: "string", description: "Field to sort by, e.g. fileSize, playCount, year, title, addedAt, lastPlayedAt." },
        sortOrder: { type: "string", enum: ["asc", "desc"] },
        limit: { type: "number", description: "Max items to return (default 25, max 50)." },
      },
      additionalProperties: false,
    },
  },
  async execute(userId, args) {
    const s = await scope(userId);
    if (!s) return NO_SERVERS;

    const mediaTypes = Array.isArray(args.mediaTypes)
      ? (args.mediaTypes.filter((t) => MEDIA_TYPES.includes(t as (typeof MEDIA_TYPES)[number])) as ("MOVIE" | "SERIES" | "MUSIC")[])
      : [];
    const rawFilters = Array.isArray(args.filters) ? args.filters : [];
    const condition = args.match === "any" ? "OR" : "AND";

    const rules = [] as QueryDefinition["groups"][number]["rules"];
    for (let i = 0; i < rawFilters.length && i < 20; i++) {
      const f = rawFilters[i] as { field?: unknown; operator?: unknown; value?: unknown };
      const field = String(f.field ?? "");
      const operator = String(f.operator ?? "");
      if (!SEARCH_FIELD_SET.has(field)) {
        return {
          data: {
            error: `Field "${field}" is not available. Arr/Seerr-specific fields aren't supported by the assistant. Valid fields include: ${SEARCH_FIELDS.slice(0, 40).map((x) => x.value).join(", ")} …`,
          },
        };
      }
      if (!OPERATOR_VALUES.has(operator)) {
        return { data: { error: `Operator "${operator}" is invalid. Valid: ${[...OPERATOR_VALUES].join(", ")}` } };
      }
      const valueless = VALUELESS_OPERATORS.has(operator);
      const value = f.value;
      if (!valueless && (value === undefined || value === null || value === "")) {
        return { data: { error: `Operator "${operator}" on "${field}" requires a value.` } };
      }
      rules.push({
        id: `r${i}`,
        field,
        operator,
        value: valueless ? "" : (typeof value === "number" ? value : String(value)),
        condition,
      });
    }

    const definition: QueryDefinition = {
      mediaTypes,
      serverIds: [],
      groups: rules.length > 0 ? [{ id: "g", condition: "AND", rules, groups: [] }] : [],
      sortBy: typeof args.sortBy === "string" && args.sortBy ? args.sortBy : "title",
      sortOrder: args.sortOrder === "desc" ? "desc" : "asc",
      includeEpisodes: false,
    };
    const limit = clampInt(args.limit, 25, 1, 50);
    const result = await executeQuery(definition, userId, 1, limit);

    const items = result.items.map((it) => {
      const r = it as Record<string, unknown>;
      return {
        title: r.title,
        parentTitle: r.parentTitle ?? undefined,
        year: r.year ?? undefined,
        type: r.type,
        resolution: r.resolution ?? undefined,
        videoCodec: r.videoCodec ?? undefined,
        audioCodec: r.audioCodec ?? undefined,
        dynamicRange: r.dynamicRange ?? undefined,
        container: r.container ?? undefined,
        sizeGB: r.fileSize != null ? gb(r.fileSize as string) : undefined,
        playCount: r.playCount ?? undefined,
        lastPlayedAt: r.lastPlayedAt ?? undefined,
        studio: r.studio ?? undefined,
      };
    });
    const data = { count: items.length, hasMore: result.pagination.hasMore, items };
    return {
      data,
      evidence: { tool: "search_media", kind: "search", title: "Matching items", data },
    };
  },
};

const getWatchTrends: AiTool = {
  definition: {
    name: "get_watch_trends",
    description:
      "What's popular RIGHT NOW on your servers: ranks titles by number of plays within a recent rolling window (default last 30 days). Series/music are rolled up to the show/artist. This is the correct tool for 'most popular shows lately' — it reflects only your own servers' activity, not global/outside-world trends.",
    parameters: {
      type: "object",
      properties: {
        mediaType: { type: "string", enum: [...MEDIA_TYPES], description: "Optional: restrict to one media type." },
        days: { type: "number", description: "Rolling window in days (default 30)." },
        limit: { type: "number", description: "How many to return (default 10, max 100)." },
      },
      additionalProperties: false,
    },
  },
  async execute(userId, args) {
    const s = await scope(userId);
    if (!s) return NO_SERVERS;
    const mediaType = MEDIA_TYPES.includes(args.mediaType as (typeof MEDIA_TYPES)[number])
      ? (args.mediaType as "MOVIE" | "SERIES" | "MUSIC")
      : undefined;
    const days = clampInt(args.days, 30, 1, 3650);
    const rows = await computeWatchTrends(s.serverIds, { mediaType, days, limit: clampInt(args.limit, 10, 1, 100) });
    const data = { days, mediaType: mediaType ?? "all", rows };
    return {
      data,
      evidence: { tool: "get_watch_trends", kind: "watch_trends", title: `Most-played (last ${days} days)`, data },
    };
  },
};

const getWatchLeaderboard: AiTool = {
  definition: {
    name: "get_watch_leaderboard",
    description:
      "Rank users, devices, or platforms by number of plays within a recent rolling window — 'who watches the most', 'what devices/platforms are used most'. Reflects your own servers' watch history only.",
    parameters: {
      type: "object",
      properties: {
        groupBy: { type: "string", enum: ["user", "device", "platform"], description: "What to rank." },
        days: { type: "number", description: "Rolling window in days (default 30)." },
        limit: { type: "number", description: "How many to return (default 15, max 100)." },
      },
      required: ["groupBy"],
      additionalProperties: false,
    },
  },
  async execute(userId, args) {
    const groupBy = args.groupBy;
    if (groupBy !== "user" && groupBy !== "device" && groupBy !== "platform") {
      return { data: { error: "groupBy must be one of: user, device, platform." } };
    }
    const s = await scope(userId);
    if (!s) return NO_SERVERS;
    const days = clampInt(args.days, 30, 1, 3650);
    const rows = await computeWatchLeaderboard(s.serverIds, { groupBy, days, limit: clampInt(args.limit, 15, 1, 100) });
    const data = { groupBy, days, rows };
    return {
      data,
      evidence: { tool: "get_watch_leaderboard", kind: "watch_leaderboard", title: `Top ${groupBy}s (last ${days} days)`, data },
    };
  },
};

const ALL_TOOLS: AiTool[] = [
  getLibraryOverview,
  getBreakdown,
  getCrossTab,
  getTimeline,
  searchMedia,
  getWatchTrends,
  getWatchLeaderboard,
];

/** All read-only analysis tools, keyed by name. */
export function getAiTools(): AiTool[] {
  return ALL_TOOLS;
}

export function getAiToolMap(): Map<string, AiTool> {
  return new Map(ALL_TOOLS.map((t) => [t.definition.name, t]));
}

export type { AiToolResult };
