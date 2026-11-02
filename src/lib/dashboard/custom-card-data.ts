import type { CustomCardConfig } from "@/lib/dashboard/card-registry";
// Types only: the schema module is server code, and nothing of it may reach
// the dashboard's script.
import type { CustomStatsCardRequest } from "@/lib/validation";

/** One custom card's data request, as `POST /api/media/stats/custom-batch` takes it. */
export type CustomCardRequest = CustomStatsCardRequest;

export type BreakdownRow = { value: string | null; type: string; _count: number };
export type CrossTabRow = { dim1: string | null; dim2: string | null; type: string; _count: number };
export type TimelinePoint = { date: string; total: number; breakdown?: Record<string, number> };
export type TimelineData = { points: TimelinePoint[]; series: string[] };

/** A card's data, by the route that answered it. */
export type CustomCardData =
  | { kind: "timeline"; timeline: TimelineData }
  | { kind: "crossTab"; rows: CrossTabRow[] }
  | { kind: "custom"; breakdown: BreakdownRow[] };

/** One card's answer: its route's status (0 when the request itself failed) and parsed body. */
export interface CustomCardAnswer {
  status: number;
  body: unknown;
}

/**
 * Most cards one batch request carries — `MAX_CUSTOM_STATS_BATCH` in
 * `src/lib/validation.ts`, repeated because that module is server code (a unit
 * test pins the two together). A layout with more cards is sent in several.
 */
export const CUSTOM_CARD_BATCH_LIMIT = 50;

/** The largest top-N the batch accepts; any larger one shows every value anyway. */
const MAX_TOP_N = 10_000;

export const CUSTOM_CARD_BATCH_URL = "/api/media/stats/custom-batch";

/**
 * The request a custom card makes for `config` under the dashboard's scope:
 * the same parameters its own route was sent. Only a timeline is filtered by
 * type on the server; breakdowns and cross-tabs return every type and the card
 * filters them, so a type change on one of those asks for nothing new. A
 * heatmap with no second dimension asks for its breakdown, as it always did.
 */
export function customCardRequest(
  config: CustomCardConfig,
  scope: { serverId?: string; filterType?: string },
): CustomCardRequest {
  const server = scope.serverId ? { serverId: scope.serverId } : {};
  if (config.chartType === "timeline") {
    const topN = config.topN;
    return {
      kind: "timeline",
      dateField: config.dimension,
      bin: config.timelineBin ?? "month",
      ...(config.dimension2 ? { breakdown: config.dimension2 } : {}),
      // The route read `topN` with parseInt; the batch takes an integer.
      ...(typeof topN === "number" && Number.isFinite(topN)
        ? { topN: Math.min(Math.max(Math.trunc(topN), 0), MAX_TOP_N) }
        : {}),
      ...server,
      ...(scope.filterType ? { type: scope.filterType } : {}),
    };
  }
  if (config.chartType === "heatmap" && config.dimension2) {
    return { kind: "crossTab", dimension1: config.dimension, dimension2: config.dimension2, ...server };
  }
  return { kind: "custom", dimension: config.dimension, ...server };
}

/** Two requests with the same key are the same question (built field by field, in one order). */
export function customCardRequestKey(request: CustomCardRequest): string {
  return JSON.stringify(request);
}

/**
 * The card's data from its answer, or null when it failed: an error status,
 * a failed request, or a body that is not an object. A missing list reads as
 * empty, as each card read its own response.
 */
export function customCardDataFrom(
  kind: CustomCardRequest["kind"],
  answer: CustomCardAnswer,
): CustomCardData | null {
  const { status, body } = answer;
  if (status < 200 || status >= 300 || !body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  switch (kind) {
    case "timeline":
      return {
        kind,
        timeline: {
          points: Array.isArray(b.points) ? (b.points as TimelinePoint[]) : [],
          series: Array.isArray(b.series) ? (b.series as string[]) : [],
        },
      };
    case "crossTab":
      return { kind, rows: Array.isArray(b.rows) ? (b.rows as CrossTabRow[]) : [] };
    case "custom":
      return { kind, breakdown: Array.isArray(b.breakdown) ? (b.breakdown as BreakdownRow[]) : [] };
  }
}

const FAILED: CustomCardAnswer = { status: 0, body: null };

/** Sends one batch; resolves with one answer per card in order, or null when the batch failed. */
export type SendCustomCardBatch = (cards: CustomCardRequest[]) => Promise<CustomCardAnswer[] | null>;

export const postCustomCardBatch: SendCustomCardBatch = async (cards) => {
  try {
    const res = await fetch(CUSTOM_CARD_BATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cards }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { cards?: unknown };
    if (!Array.isArray(data.cards) || data.cards.length !== cards.length) return null;
    return data.cards.map((entry) =>
      entry && typeof entry === "object" && typeof (entry as CustomCardAnswer).status === "number"
        ? { status: (entry as CustomCardAnswer).status, body: (entry as CustomCardAnswer).body ?? null }
        : FAILED,
    );
  } catch {
    return null;
  }
};

export interface CustomCardBatcher {
  /** One card's answer, sent with every other card that asks in the same turn. */
  load(request: CustomCardRequest): Promise<CustomCardAnswer>;
}

/**
 * Collects the custom cards' requests made in one synchronous turn — every
 * card's effect of one render runs in one — and sends them as one batch
 * (`POST /api/media/stats/custom-batch`), so a dashboard load, a server pick
 * or a type change costs one request however many custom cards there are; it
 * cost one per card. A request asked twice in the turn is sent once. Every
 * card still gets its own answer: one card's 4xx/500 fails only that card,
 * and a batch that fails as a whole fails each of its cards — none is ever
 * left without an answer, and none is handed another's.
 */
export function createCustomCardBatcher(send: SendCustomCardBatch = postCustomCardBatch): CustomCardBatcher {
  let queue: { request: CustomCardRequest; key: string; resolve: (answer: CustomCardAnswer) => void }[] | null = null;

  async function flush() {
    const entries = queue ?? [];
    queue = null;
    const unique = new Map<string, CustomCardRequest>();
    for (const entry of entries) if (!unique.has(entry.key)) unique.set(entry.key, entry.request);
    const keys = [...unique.keys()];
    const answers = new Map<string, CustomCardAnswer>();
    const chunks: string[][] = [];
    for (let i = 0; i < keys.length; i += CUSTOM_CARD_BATCH_LIMIT) chunks.push(keys.slice(i, i + CUSTOM_CARD_BATCH_LIMIT));
    await Promise.all(
      chunks.map(async (chunk) => {
        let result: CustomCardAnswer[] | null = null;
        try {
          result = await send(chunk.map((key) => unique.get(key)!));
        } catch {
          result = null;
        }
        chunk.forEach((key, i) => answers.set(key, result?.[i] ?? FAILED));
      }),
    );
    for (const entry of entries) entry.resolve(answers.get(entry.key) ?? FAILED);
  }

  return {
    load(request) {
      return new Promise((resolve) => {
        if (!queue) {
          queue = [];
          queueMicrotask(() => void flush());
        }
        queue.push({ request, key: customCardRequestKey(request), resolve });
      });
    },
  };
}

/** The dashboard's batcher: one per tab, shared by every custom card. */
export const customCardBatcher = createCustomCardBatcher();
