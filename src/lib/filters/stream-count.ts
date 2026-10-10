import type { PrismaClient } from "@/generated/prisma/client";

interface CountCondition {
  op: string;
  value: number;
}

/** Audio and subtitle track-count conditions from a list route's query string. */
export interface StreamCountFilters {
  audio: CountCondition[];
  subtitle: CountCondition[];
}

/**
 * A count is compared as a Postgres `integer`. A value past that range
 * (`gt:99999999999999999999`) failed the query with a 500; clamped, it still
 * answers the same question — nothing has more than 2^31 tracks.
 */
const INT_MIN = -(2 ** 31);
const INT_MAX = 2 ** 31 - 1;

function parseCountConditions(raw: string | null): CountCondition[] {
  if (!raw) return [];
  return raw
    .split("|")
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(":");
      const op = idx === -1 ? "eq" : part.slice(0, idx);
      const num = parseInt(idx === -1 ? part : part.slice(idx + 1));
      return Number.isNaN(num) ? null : { op, value: Math.min(INT_MAX, Math.max(INT_MIN, num)) };
    })
    .filter((c): c is CountCondition => c !== null);
}

function opToSql(op: string): string {
  switch (op) {
    case "gt": return ">";
    case "lt": return "<";
    case "gte": return ">=";
    case "lte": return "<=";
    case "eq":
    default: return "=";
  }
}

/** The stream-count conditions in `params`, or `null` when there are none. */
export function parseStreamCountFilters(params: URLSearchParams): StreamCountFilters | null {
  const audio = parseCountConditions(params.get("audioStreamCountConditions"));
  const subtitle = parseCountConditions(params.get("subtitleStreamCountConditions"));
  return audio.length === 0 && subtitle.length === 0 ? null : { audio, subtitle };
}

/**
 * Which of `ids` satisfy every condition — in one statement, with the ids as a
 * single array parameter.
 *
 * This used to collect the id of EVERY item on the install whose streams
 * matched (no scope, episodes and tracks included) and add `id IN (<them>)` to
 * the list query: past ~32k ids that is more bind parameters than the
 * database takes, and `?audioStreamCountConditions=gte:1` answered 500 on any
 * install with that many items carrying an audio track. Counting from the
 * items with a LEFT JOIN also lets an item with no stream rows at all count as
 * 0 tracks, where the old GROUP BY over `MediaStream` never saw it.
 */
export async function filterIdsByStreamCounts(
  db: PrismaClient,
  ids: string[],
  filters: StreamCountFilters,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const having: string[] = [];
  const values: number[] = [];
  const add = (streamType: number, c: CountCondition) => {
    values.push(c.value);
    having.push(`COUNT(ms."id") FILTER (WHERE ms."streamType" = ${streamType}) ${opToSql(c.op)} $${values.length + 1}::int`);
  };
  for (const c of filters.audio) add(2, c);
  for (const c of filters.subtitle) add(3, c);

  const rows = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT item.id FROM unnest($1::text[]) AS item(id)
     LEFT JOIN "MediaStream" ms ON ms."mediaItemId" = item.id
     GROUP BY item.id
     HAVING ${having.join(" AND ")}`,
    ids,
    ...values,
  );
  return new Set(rows.map((r) => r.id));
}
