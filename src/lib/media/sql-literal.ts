/**
 * A string as the body of a single-quoted SQL literal: every `'` doubled.
 *
 * For the dimension registry's fixed labels (null labels, value-map labels)
 * that the breakdown and timeline builders splice into a `CASE`/`COALESCE` —
 * never for request input, which goes in as a bind parameter. One copy: the
 * two builders each carried their own.
 */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
