/**
 * Leading-edge throttle with a trailing fire.
 *
 * The first `trigger()` after an idle period runs `fn` immediately (so a genuine
 * change is acted on with no delay); further triggers within `intervalMs` are
 * coalesced into a single trailing run at the interval boundary. This bounds how
 * often an expensive side effect (the maintenance/transcode enforcer, which
 * polls every server) can run, no matter how fast events arrive — unlike a pure
 * trailing debounce, which fires once per event when events are spaced wider than
 * the quiet window.
 *
 * `fn` runs with no arguments and must handle its own async rejection.
 */
export class Throttle {
  private readonly fn: () => void;
  private readonly intervalMs: number;
  private lastRun = 0;
  private trailing: ReturnType<typeof setTimeout> | null = null;

  constructor(fn: () => void, intervalMs: number) {
    this.fn = fn;
    this.intervalMs = intervalMs;
  }

  trigger(): void {
    const now = Date.now();
    const elapsed = now - this.lastRun;
    if (elapsed >= this.intervalMs) {
      this.lastRun = now;
      this.run();
    } else if (this.trailing == null) {
      this.trailing = setTimeout(() => {
        this.trailing = null;
        this.lastRun = Date.now();
        this.run();
      }, this.intervalMs - elapsed);
    }
  }

  cancel(): void {
    if (this.trailing) {
      clearTimeout(this.trailing);
      this.trailing = null;
    }
  }

  private run(): void {
    try {
      this.fn();
    } catch {
      // Swallow synchronous throws — a bad side effect must not kill the caller.
    }
  }
}
