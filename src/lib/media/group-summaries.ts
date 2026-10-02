import { prisma } from "@/lib/db";

/**
 * Blurbs for grouped listings whose representative row has none.
 *
 * The series and season listings pick one representative episode per group
 * for artwork, and take the summary from that same row. Show-level text is on
 * every episode so that almost always works — but a season's art row and its
 * only summarised episode can differ, and the JS fold this replaced picked
 * each field independently. Rather than carry the summary text through the
 * aggregate (the width that made the single-query version slow), the
 * aggregate records the id of the first summarised episode and this fetches
 * the text for just the groups that need it: a primary-key lookup, and on a
 * real library it runs for a handful of groups or none.
 *
 * Takes `[groupKey, mediaItemId]` pairs and the field the caller is completing
 * (`"show"`: `parentSummary`, else the episode's own; `"episode"`: the
 * episode's own only) and returns groupKey → summary. Blank text counts as
 * missing, as it did in the JS fold.
 */
export async function loadMissingSummaries(
  pairs: ReadonlyArray<readonly [string, string]>,
  source: "show" | "episode",
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (pairs.length === 0) return out;
  // The caller says which text it is completing, so the fallback reads the
  // same field its primary path did: the series listing wants the show blurb
  // (episode text only when there is none), the season listing the episode's.
  const expr =
    source === "show"
      ? `COALESCE(NULLIF("parentSummary", ''), NULLIF("summary", ''))`
      : `NULLIF("summary", '')`;
  const rows = await prisma.$queryRawUnsafe<{ id: string; summary: string | null }[]>(
    `SELECT id, ${expr} AS summary FROM "MediaItem" WHERE id = ANY($1::text[])`,
    pairs.map(([, id]) => id),
  );
  const byId = new Map(rows.map((r) => [r.id, r.summary]));
  for (const [key, id] of pairs) {
    const summary = byId.get(id);
    if (summary) out.set(key, summary);
  }
  return out;
}
