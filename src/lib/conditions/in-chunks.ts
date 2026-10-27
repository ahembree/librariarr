/**
 * Postgres takes at most 32,767 bind parameters per statement. Prisma splits a
 * lone `in` list on a plain findMany, but not on a groupBy, nor when the same
 * query also carries a relation filter or a second list — and a list built
 * from a rule set's matches is as long as the library (38k tracks for one
 * track-scope music rule set), so such a query failed the whole run with
 * P2029. Lists that can be that long are sent in slices of this size, which
 * leaves room for the query's other parameters.
 */
export const IN_CHUNK_SIZE = 10_000;

export function inChunks<T>(values: readonly T[], size: number = IN_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Run `query` over each slice of `values`, one after another, and concatenate the rows. */
export async function findInChunks<T, R>(
  values: readonly T[],
  query: (chunk: T[]) => Promise<R[]>,
  size: number = IN_CHUNK_SIZE,
): Promise<R[]> {
  const rows: R[] = [];
  for (const chunk of inChunks(values, size)) {
    // Not `push(...rows)`: a slice can answer with more rows than a call takes arguments.
    for (const row of await query(chunk)) rows.push(row);
  }
  return rows;
}
