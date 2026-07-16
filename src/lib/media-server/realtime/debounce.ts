export interface DebouncerOptions {
  /** Fire once the input has been quiet for this long (ms). */
  quietMs: number;
  /**
   * Upper bound (ms) from the FIRST trigger of a burst to the fire, so a
   * continuous stream of triggers (e.g. a long library scan emitting a change
   * event per item) can't postpone the action indefinitely.
   */
  maxWaitMs?: number;
}

/**
 * Trailing-edge debouncer with an optional max-wait ceiling.
 *
 * Used to coalesce bursts of real-time events into a single side effect: a
 * library scan that fires hundreds of `library-changed` events becomes one
 * incremental sync; a flurry of session updates becomes one enforcer tick.
 *
 * `fn` is invoked with no arguments; if it starts async work it must handle its
 * own rejection (this class only guards synchronous throws).
 */
export class Debouncer {
  private readonly fn: () => void;
  private readonly quietMs: number;
  private readonly maxWaitMs?: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(fn: () => void, options: DebouncerOptions) {
    this.fn = fn;
    this.quietMs = options.quietMs;
    this.maxWaitMs = options.maxWaitMs;
  }

  /** Schedule (or reschedule) the trailing fire. */
  trigger(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), this.quietMs);
    if (this.maxWaitMs != null && this.maxTimer == null) {
      this.maxTimer = setTimeout(() => this.run(), this.maxWaitMs);
    }
  }

  /** Cancel any pending fire without running it. */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
  }

  /** Run immediately if a fire is pending; no-op otherwise. */
  flush(): void {
    if (this.timer || this.maxTimer) this.run();
  }

  private run(): void {
    this.cancel();
    try {
      this.fn();
    } catch {
      // Swallow synchronous throws — a bad side effect must not kill the caller.
    }
  }
}
