import { describe, it, expect } from "vitest";
import { ResponseOrder } from "@/lib/media/response-order";

/**
 * A stand-in for a page's import-status state, applying answers exactly as the
 * pages do: an answer with data through `accept`; a failure changes nothing on
 * the History page, and on Settings hides the readout unless overtaken.
 */
function statusReader({ clearOnFailure = false } = {}) {
  const order = new ResponseOrder();
  const state = { pending: null as boolean | null, applied: 0 };
  return {
    state,
    read() {
      const seq = order.begin();
      return {
        answer(pending: boolean) {
          if (!order.accept(seq)) return;
          state.pending = pending;
          state.applied++;
        },
        fail() {
          if (clearOnFailure && !order.isOvertaken(seq)) state.pending = null;
        },
      };
    },
  };
}

describe("ResponseOrder", () => {
  it("applies every answer that lands in the order it was asked", () => {
    const order = new ResponseOrder();
    const a = order.begin();
    const b = order.begin();
    const c = order.begin();
    expect(order.accept(a)).toBe(true);
    expect(order.accept(b)).toBe(true);
    expect(order.accept(c)).toBe(true);
  });

  it("refuses an older answer that lands after a newer one applied", () => {
    const order = new ResponseOrder();
    const older = order.begin();
    const newer = order.begin();
    expect(order.isOvertaken(older)).toBe(false);
    expect(order.accept(newer)).toBe(true);
    expect(order.isOvertaken(older)).toBe(true);
    expect(order.accept(older)).toBe(false);
    // ...and it stays refused, while a later read still applies.
    expect(order.accept(older)).toBe(false);
    expect(order.accept(order.begin())).toBe(true);
  });

  it("keeps a late 'pending' from bringing the import note back", () => {
    // The History page bug: the poll's read started first and answered
    // "pending" after the realtime event's newer read had answered "settled".
    const page = statusReader();
    const poll = page.read();
    const event = page.read();
    event.answer(false);
    poll.answer(true);
    expect(page.state.pending).toBe(false);
  });

  it("never starves a resource re-read faster than it answers", () => {
    // Every read starts before the previous one answers (a slow status route
    // under a stream of events). "Only the newest request may apply" would
    // apply none of these; every one of them is newer than what is shown.
    const page = statusReader();
    let inFlight = page.read();
    for (let i = 0; i < 10; i++) {
      const next = page.read();
      inFlight.answer(i % 2 === 0);
      inFlight = next;
    }
    inFlight.answer(true);
    expect(page.state.applied).toBe(11);
    expect(page.state.pending).toBe(true);
  });

  it("lets an older answer apply when the newer read failed", () => {
    // History: a failed read is "unknown" and changes nothing, so the older
    // answer still on its way is the newest state there is.
    const page = statusReader();
    const older = page.read();
    const newer = page.read();
    newer.fail();
    older.answer(true);
    expect(page.state.pending).toBe(true);
    expect(page.state.applied).toBe(1);
  });

  it("lets a failure hide a readout only while nothing newer has applied", () => {
    // Settings hides its import line on a failed read.
    const page = statusReader({ clearOnFailure: true });
    page.read().answer(true);
    page.read().fail();
    expect(page.state.pending).toBeNull();

    // A failure that lands after a NEWER answer must not hide that answer.
    const late = page.read();
    page.read().answer(false);
    late.fail();
    expect(page.state.pending).toBe(false);
  });

  it("never lets a failure block an older answer still on its way", () => {
    // The failure carries no status, so the older read's answer is the newest
    // status known when it lands — it shows rather than being thrown away.
    const page = statusReader({ clearOnFailure: true });
    const older = page.read();
    const failed = page.read();
    failed.fail();
    expect(page.state.pending).toBeNull();
    older.answer(true);
    expect(page.state.pending).toBe(true);
  });

  it("keeps separate orders apart", () => {
    const history = new ResponseOrder();
    const settings = new ResponseOrder();
    const h = history.begin();
    settings.begin();
    expect(settings.accept(settings.begin())).toBe(true);
    expect(history.accept(h)).toBe(true);
  });
});
