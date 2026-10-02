/**
 * How often a long sync phase re-reads its job's cancel flag.
 *
 * The flag is one indexed row read, and the phases this guards (a server's
 * watch-history import) run for tens of seconds to minutes, so 2s keeps Stop
 * responsive without turning the watch into a hot loop.
 */
export const CANCEL_POLL_MS = 2_000;

export interface CancelWatch {
  /** Aborts once `isCancelled` has reported true. */
  signal: AbortSignal;
  /** End the watch. Must be called when the guarded phase finishes. */
  stop: () => void;
}

/**
 * Turn a polled cancel flag into an `AbortSignal`.
 *
 * `syncMediaServer` only honoured Stop at its own checkpoints, between items
 * and between phases, so a Stop pressed during the watch-history phase was
 * never seen at all: the run finished as COMPLETED and the button had done
 * nothing. The watch-history importers already take an `AbortSignal` (the
 * History page's streaming route passes `request.signal`), so the cheapest
 * correct bridge is to poll the flag and abort.
 *
 * A check that throws is simply retried on the next tick: a transient DB error
 * must not read as a cancel, and a missed tick costs one interval of latency.
 * Checks never overlap, so a slow database cannot stack them up.
 */
export function watchForCancel(
  isCancelled: () => Promise<boolean>,
  intervalMs: number = CANCEL_POLL_MS,
): CancelWatch {
  const controller = new AbortController();
  let checking = false;

  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    isCancelled()
      .then((cancelled) => {
        if (cancelled) controller.abort();
      })
      .catch(() => {
        // Retried on the next tick; see above.
      })
      .finally(() => {
        checking = false;
      });
  }, intervalMs);
  // Never the reason the process stays alive.
  timer.unref?.();

  return {
    signal: controller.signal,
    stop: () => clearInterval(timer),
  };
}
