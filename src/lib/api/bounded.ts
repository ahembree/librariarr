/**
 * Resolve to `work`'s value, or to `null` once `ms` has elapsed — whichever
 * comes first. `onTimeout` runs only when the bound wins.
 *
 * For routes a detail page waits on that make one live call per integration
 * instance (`arr-info`, `seerr-info`): an instance that times out costs its
 * client's full retry budget (four timeouts plus backoff), and one slow
 * instance must not hold back the others' answers. The abandoned request is
 * not cancelled — it finishes in the background and its result is dropped.
 */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(null);
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
