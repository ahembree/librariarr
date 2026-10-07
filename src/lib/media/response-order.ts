/**
 * Ordering for the answers to overlapping reads of one resource that several
 * triggers re-read on their own schedule — a fallback poll, a realtime event,
 * a re-check after a sync or a save. Without it, an OLDER answer that lands
 * late overwrites a newer one already on screen: the History page's
 * "Still importing older history" note came back after a newer read had
 * cleared it (and re-armed its poll), and the Settings import line could show
 * a pre-save "fully imported" over a mapping the save had just reset.
 *
 * Deliberately not `PageRequestTracker`'s "only the newest REQUEST may apply":
 * that rule starves a resource re-read faster than it answers — a status
 * route taking three seconds under events two seconds apart would never apply
 * an answer at all. Here an answer applies unless an answer to a LATER read
 * already has, so answers arriving in order all land and only one overtaken by
 * a newer answer is dropped.
 *
 * Plain mutable object, held once per component (`useState(() => new …)`).
 * Client-safe and pure so it is unit-tested.
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
   * Whether the answer to read `seq` may be applied. `true` records it, so
   * every answer to an earlier read is refused from then on — call it after
   * the last `await`, immediately before applying.
   *
   * Only for an answer that carries data. An outcome that carries none — a
   * failed read — must not be recorded: an older answer still on its way is
   * then the newest thing known, and recording the failure would throw it
   * away. A page that reacts to a failure at all checks `isOvertaken` instead.
   */
  accept(seq: number): boolean {
    if (this.isOvertaken(seq)) return false;
    this.applied = seq;
    return true;
  }
}
