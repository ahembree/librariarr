import { describe, it, expect } from "vitest";
import { ResponseOrder } from "@/lib/media/response-order";

/**
 * A page's import-status state, applying answers as the pages do: an answer
 * through `accept`; a failure changes nothing on History, and on Settings
 * (`clearOnFailure`) hides the readout unless overtaken.
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

    // A late "pending" from the poll cannot bring the import note back.
    const page = statusReader();
    const poll = page.read();
    page.read().answer(false);
    poll.answer(true);
    expect(page.state.pending).toBe(false);
  });

  it("applies every answer that lands in order, so a slow re-read is never starved", () => {
    // Each read starts before the previous one answers; "only the newest
    // request applies" would apply none of them.
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

  it.each([false, true])("never lets a failed newer read block an older answer (clearOnFailure: %s)", (clearOnFailure) => {
    const page = statusReader({ clearOnFailure });
    const older = page.read();
    page.read().fail();
    expect(page.state.pending).toBeNull();
    older.answer(true);
    expect(page.state).toEqual({ pending: true, applied: 1 });
  });

  it("lets a failure hide a readout only while nothing newer has applied", () => {
    const page = statusReader({ clearOnFailure: true });
    page.read().answer(true);
    page.read().fail();
    expect(page.state.pending).toBeNull();

    const late = page.read();
    page.read().answer(false);
    late.fail();
    expect(page.state.pending).toBe(false);
  });
});
