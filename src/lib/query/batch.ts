import { MAX_QUERY_ACTION_ITEMS } from "./constants";

/**
 * Split a selection of media-item ids into consecutive, disjoint batches of at
 * most `size` ids.
 *
 * Bulk query actions are chunked client-side so each `POST /api/query/actions`
 * request stays within {@link MAX_QUERY_ACTION_ITEMS} (the server's per-request
 * safety cap), letting a selection of any size run as a sequence of bounded
 * requests. Order is preserved and the batches are a disjoint partition of
 * `ids`, so no item is actioned twice and the final batch holds the remainder.
 */
export function batchIds(
  ids: readonly string[],
  size: number = MAX_QUERY_ACTION_ITEMS,
): string[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`batch size must be a positive integer, got ${size}`);
  }
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    batches.push(ids.slice(i, i + size));
  }
  return batches;
}
