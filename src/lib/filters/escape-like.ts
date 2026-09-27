/**
 * Escape a user-supplied value for use inside a SQL LIKE / ILIKE pattern.
 *
 * `%`, `_` and `\` are pattern metacharacters in Postgres (`\` is the default
 * escape character), and NOTHING upstream escapes them: Prisma's `contains` /
 * `startsWith` / insensitive `equals` compile to `LIKE` / `ILIKE` with the
 * value spliced into the pattern verbatim, and the raw-SQL routes build
 * `'%' || $1 || '%'` themselves. Verified live against the public API:
 * `GET /api/v1/media/movies?search=1_ Things` matched "10 Things I Hate About
 * You" (`_` as a single-character wildcard), `?search=%Things%Hate` matched
 * it too, and `GET /api/v1/media/history?search=%` returned every play.
 * Beyond the wrong answer, a pathological pattern (`%_%_%_…`) costs ~10× the
 * CPU of a plain search on the history route's raw ILIKE.
 *
 * Escaping the three metacharacters makes Postgres match them literally, so a
 * search for "1_ Things" finds only that title. Apply to EVERY user-supplied
 * value handed to a LIKE-shaped comparison — Prisma `contains` / `startsWith`
 * / `{ equals, mode: "insensitive" }`, or a raw `LIKE` / `ILIKE` parameter.
 * Prisma's insensitive `in` is the one exception: it compiles to
 * `LOWER(col) IN (…)`, an exact comparison that must NOT be escaped.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
