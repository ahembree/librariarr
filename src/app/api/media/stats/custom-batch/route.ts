import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { withSharedSession } from "@/lib/auth/shared-session";
import { jsonResponse } from "@/lib/api/json-response";
import { apiLogger } from "@/lib/logger";
import { validateRequest, customStatsBatchSchema, type CustomStatsCardRequest } from "@/lib/validation";
import { GET as timelineGet } from "@/app/api/media/stats/timeline/route";
import { GET as crossTabGet } from "@/app/api/media/stats/cross-tab/route";
import { GET as customGet } from "@/app/api/media/stats/custom/route";

/** One card's answer: the status and parsed body its own route gives. */
interface CardAnswer {
  status: number;
  body: unknown;
}

/**
 * Cards computed at once. The browser ran at most six of these requests side
 * by side (its connection limit); fifty in parallel would take every pooled
 * database connection a cold cache needs.
 */
const CARD_CONCURRENCY = 6;

const ROUTES = {
  timeline: { path: "/api/media/stats/timeline", handler: timelineGet },
  crossTab: { path: "/api/media/stats/cross-tab", handler: crossTabGet },
  custom: { path: "/api/media/stats/custom", handler: customGet },
} as const;

/**
 * Every custom dashboard card's data in one request.
 *
 * Each card asked for its own: a timeline, a cross-tab or a breakdown, one
 * request each, beside the dozen the dashboard makes on load, on a page that
 * holds the browser's six connections per host for most of its load. Each
 * card here is answered by its own route's `GET` — the same validation, the
 * same computation and the same `timeline:` / `cross-tab:` / `custom-stats:`
 * cache — and comes back as `{ status, body }` in the order sent, one card's
 * failure a 4xx/500 entry beside the others. One session check for all of
 * them (`withSharedSession`).
 */
export async function POST(request: NextRequest) {
  return withSharedSession(async () => {
    const session = await getSession();
    if (!session.isLoggedIn) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await validateRequest(request, customStatsBatchSchema);
    if (error) return error;

    const cards = new Array<CardAnswer>(data.cards.length);
    let next = 0;
    const worker = async () => {
      while (next < data.cards.length) {
        const index = next++;
        cards[index] = await answerCard(request, data.cards[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CARD_CONCURRENCY, data.cards.length) }, worker));
    return jsonResponse(request, { cards });
  });
}

async function answerCard(request: NextRequest, card: CustomStatsCardRequest): Promise<CardAnswer> {
  const { kind, ...fields } = card;
  const route = ROUTES[kind];
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    // A card with no top-N sends none, as its own request left `topN` out.
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  try {
    const res = await route.handler(new NextRequest(new URL(`${route.path}?${params}`, request.url)));
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    apiLogger.error("Stats", `Batched ${kind} card failed`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 500, body: { error: "Internal server error" } };
  }
}
