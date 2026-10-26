/**
 * Run `fn` over `items` with at most `limit` calls in flight, returning the
 * results in input order.
 *
 * A real pool rather than fixed waves: with `Promise.all` over slices of
 * `limit`, one slow request held up the whole wave while the other slots sat
 * idle. Here a slot that finishes takes the next item straight away.
 *
 * Fails fast: the first rejection is rethrown once the calls already running
 * have settled, and no further item is started after it. Callers that must not
 * stop on a failure catch inside `fn` (see `settleWithConcurrency`).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  };

  const slots = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: slots }, worker));
  if (failed) throw firstError;
  return results;
}

/**
 * `mapWithConcurrency` that never stops early: every item runs, and each
 * result is reported as a `PromiseSettledResult`, in input order — the pooled
 * counterpart of `Promise.allSettled`.
 */
export function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapWithConcurrency(items, limit, async (item, index): Promise<PromiseSettledResult<R>> => {
    try {
      return { status: "fulfilled", value: await fn(item, index) };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  });
}
