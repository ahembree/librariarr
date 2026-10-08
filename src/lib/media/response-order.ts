/**
 * Ordering for overlapping reads of one resource (a poll, realtime events, re-checks):
 * an answer applies unless an answer to a LATER read already has, so a late older
 * answer never overwrites a newer one. Deliberately not `PageRequestTracker`'s "only
 * the newest request applies", which starves a resource re-read faster than it answers.
 */
export class ResponseOrder {
  private issued = 0;
  private applied = 0;

  /** Starts a read; hand the number it returns to `accept`/`isOvertaken`. */
  begin(): number {
    return ++this.issued;
  }

  /** Whether an answer to a LATER read than `seq` has already been applied. */
  isOvertaken(seq: number): boolean {
    return seq <= this.applied;
  }

  /**
   * Whether the answer to `seq` may be applied; `true` records it. Call it after the
   * last `await`, and only for an answer with data: recording a failed read would throw
   * away an older answer still on its way (a failure handler checks `isOvertaken`).
   */
  accept(seq: number): boolean {
    if (this.isOvertaken(seq)) return false;
    this.applied = seq;
    return true;
  }
}
