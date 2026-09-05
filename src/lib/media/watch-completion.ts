import type { Prisma } from "@/generated/prisma/client";

/**
 * The single definition of "a `WatchHistory` row that counts as a play".
 *
 * `WatchHistory` holds two provenances. A `NATIVE` row comes from the media
 * server's own history and is always a completed play, so its `watched` column
 * is null. A `TRACEARR` row is an aggregate over a resume chain and carries a
 * real boolean: `watched` is true once the play crossed Tracearr's per-media-
 * type completion threshold (85% by default), and false while it is a partial
 * or still-in-progress view.
 *
 * Before Tracearr, every row in the table was a completed play, and several
 * consumers were written against that assumption. Storing partial plays
 * silently redefines what those consumers mean unless they all adopt the same
 * predicate — so it lives here, once, in both the SQL and Prisma dialects:
 *
 *  - `watch-reconcile.ts` rolls rows into `MediaItem.playCount`/`lastPlayedAt`,
 *    the columns the lifecycle and query engines read to arm DELETE actions.
 *  - The `watchedByUser` rule field asks "did this user watch this?", in Phase 1
 *    as a Prisma relation filter (`conditions/where-builder.ts`) and in Phase 2
 *    against an eager-loaded `watchHistory` relation (both engines).
 *
 * Phase 1 and Phase 2 must agree — a rule that matches a different set
 * depending on whether something else in the rule set forced in-memory
 * re-evaluation is exactly the class of bug the shared evaluators exist to
 * prevent — so both dialects are derived from this one place.
 *
 * Deliberately NOT applied to `src/lib/media/watch-analytics.ts`: trending and
 * leaderboards measure engagement, where starting something is a real signal,
 * and nothing there feeds a destructive rule.
 */

/**
 * SQL predicate. `IS DISTINCT FROM false` is the null-safe spelling of
 * "watched = true OR watched IS NULL" — a plain `<> false` would drop every
 * NATIVE row, since NULL `<>` false is NULL, not true.
 *
 * Callers must qualify it themselves when the query joins more than one table
 * (pass the alias, e.g. `completedPlaySql('wh')`).
 */
export function completedPlaySql(alias?: string): string {
  const column = alias ? `${alias}."watched"` : `"watched"`;
  return `${column} IS DISTINCT FROM false`;
}

/**
 * Prisma dialect of the same predicate, for a `WatchHistory` relation filter or
 * a relation-level `where`.
 *
 * Spelled as an explicit `OR` rather than `{ watched: { not: false } }` because
 * `not` on a nullable column does not reliably admit NULLs across Prisma
 * versions, and silently excluding every NATIVE row here would make a
 * `watchedByUser` rule match nothing on a server that has no Tracearr mapping.
 */
export const COMPLETED_PLAY_FILTER: Prisma.WatchHistoryWhereInput = {
  OR: [{ watched: true }, { watched: null }],
};
