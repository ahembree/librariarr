import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  tryBeginExecute,
  endExecute,
  queryExecuteKey,
  tryBeginRuleSetExecution,
  endRuleSetExecution,
  tryBeginQueryExecution,
  beginQueryExecution,
  endQueryExecution,
  _resetExecuteInFlightForTesting,
} from "@/lib/lifecycle/execute-in-flight";

/** Whether a run holds `scope` (or, given one, `item`): probed by claiming it and letting go. */
function running(scope: string, item?: string): boolean {
  const items = item === undefined ? undefined : [item];
  if (!tryBeginExecute(scope, items)) return true;
  endExecute(scope, items);
  return false;
}

describe("lifecycle execute single-flight registry", () => {
  beforeEach(() => _resetExecuteInFlightForTesting());

  it("claims a free key and refuses a second claim until it is released", () => {
    expect(tryBeginExecute("rs-1")).toBe(true);
    expect(running("rs-1")).toBe(true);
    expect(tryBeginExecute("rs-1")).toBe(false);
    endExecute("rs-1");
    expect(running("rs-1")).toBe(false);
    expect(tryBeginExecute("rs-1")).toBe(true);
  });

  it("keys are independent — another rule set is never blocked", () => {
    expect(tryBeginExecute("rs-1")).toBe(true);
    expect(tryBeginExecute("rs-2")).toBe(true);
    endExecute("rs-1");
    expect(running("rs-2")).toBe(true);
  });

  it("releasing an unheld key is a no-op and does not disturb a held one", () => {
    expect(tryBeginExecute("rs-1")).toBe(true);
    endExecute("rs-2");
    expect(running("rs-1")).toBe(true);
  });

  it("is released after the guarded work throws, when released from a finally", async () => {
    const run = async () => {
      if (!tryBeginExecute("rs-1")) throw new Error("busy");
      try {
        throw new Error("Arr exploded");
      } finally {
        endExecute("rs-1");
      }
    };
    await expect(run()).rejects.toThrow("Arr exploded");
    expect(running("rs-1")).toBe(false);
    expect(tryBeginExecute("rs-1")).toBe(true);
  });

  it("namespaces the ad-hoc query key per user so it cannot collide with a rule set id", () => {
    expect(queryExecuteKey("u1")).toBe("query:u1");
    expect(tryBeginExecute(queryExecuteKey("u1"))).toBe(true);
    expect(tryBeginExecute(queryExecuteKey("u1"))).toBe(false);
    expect(tryBeginExecute("u1")).toBe(true);
  });

  it("shares one registry across module instances via globalThis", async () => {
    // The route bundle and the job worker each evaluate the module; Next.js
    // dev HMR re-evaluates it too. Two copies with separate sets would let two
    // requests through, so the set is pinned on globalThis.
    expect(tryBeginExecute("rs-1")).toBe(true);
    vi.resetModules();
    const second = await import("@/lib/lifecycle/execute-in-flight");
    // The second copy sees the first copy's claim, and releases it for both.
    expect(second.tryBeginExecute("rs-1")).toBe(false);
    second.endExecute("rs-1");
    expect(tryBeginExecute("rs-1")).toBe(true);
  });

  // The Pending page runs per-item Executes side by side; a rule-set-wide lock
  // made the second one answer 409 though it acted on a different match.
  describe("item claims within a scope", () => {
    it("lets disjoint items of one rule set run together", () => {
      expect(tryBeginExecute("rs-1", ["a"])).toBe(true);
      expect(tryBeginExecute("rs-1", ["b", "c"])).toBe(true);
      expect(running("rs-1", "a")).toBe(true);
      expect(running("rs-1", "c")).toBe(true);
      expect(running("rs-1", "d")).toBe(false);
    });

    it("refuses a claim that overlaps an item already running", () => {
      expect(tryBeginExecute("rs-1", ["a", "b"])).toBe(true);
      expect(tryBeginExecute("rs-1", ["b", "z"])).toBe(false);
      // The refused claim took nothing: z is still free.
      expect(running("rs-1", "z")).toBe(false);
      expect(tryBeginExecute("rs-1", ["z"])).toBe(true);
    });

    it("refuses the whole rule set while any item runs, and any item while the whole runs", () => {
      expect(tryBeginExecute("rs-1", ["a"])).toBe(true);
      expect(tryBeginExecute("rs-1")).toBe(false);
      endExecute("rs-1", ["a"]);
      expect(tryBeginExecute("rs-1")).toBe(true);
      expect(tryBeginExecute("rs-1", ["b"])).toBe(false);
      expect(running("rs-1", "b")).toBe(true);
    });

    it("treats an empty item list as the whole scope", () => {
      expect(tryBeginExecute("rs-1", [])).toBe(true);
      expect(tryBeginExecute("rs-1", ["a"])).toBe(false);
      endExecute("rs-1", []);
      expect(running("rs-1")).toBe(false);
    });

    it("releases only what a run claimed", () => {
      expect(tryBeginExecute("rs-1", ["a"])).toBe(true);
      expect(tryBeginExecute("rs-1", ["b"])).toBe(true);
      endExecute("rs-1", ["a"]);
      expect(running("rs-1", "a")).toBe(false);
      expect(running("rs-1", "b")).toBe(true);
      expect(tryBeginExecute("rs-1")).toBe(false);
      endExecute("rs-1", ["b"]);
      expect(running("rs-1")).toBe(false);
      expect(tryBeginExecute("rs-1")).toBe(true);
    });
  });

  describe("query runs and rule-set runs exclude each other", () => {
    it("refuses a query run while a rule-set run is in progress for the user", () => {
      expect(tryBeginRuleSetExecution("u1")).toBe(true);
      expect(tryBeginQueryExecution("u1")).toBe("rule-set-running");
      endRuleSetExecution("u1");
      expect(tryBeginQueryExecution("u1")).toBe("claimed");
    });

    it("refuses a rule-set run while a query run is in progress for the user", () => {
      expect(tryBeginQueryExecution("u1")).toBe("claimed");
      expect(tryBeginRuleSetExecution("u1")).toBe(false);
      expect(tryBeginQueryExecution("u1")).toBe("query-running");
      endQueryExecution("u1");
      expect(tryBeginRuleSetExecution("u1")).toBe(true);
    });

    it("never makes two rule-set runs refuse each other, and counts both", () => {
      expect(tryBeginRuleSetExecution("u1")).toBe(true);
      expect(tryBeginRuleSetExecution("u1")).toBe(true);
      endRuleSetExecution("u1");
      expect(tryBeginQueryExecution("u1")).toBe("rule-set-running");
      endRuleSetExecution("u1");
      expect(tryBeginQueryExecution("u1")).toBe("claimed");
    });

    it("keeps users apart", () => {
      expect(tryBeginRuleSetExecution("u1")).toBe(true);
      expect(tryBeginQueryExecution("u2")).toBe("claimed");
    });
  });

  describe("beginQueryExecution", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("waits for running rule-set executions instead of refusing", async () => {
      expect(tryBeginRuleSetExecution("u1")).toBe(true);
      const claim = beginQueryExecution("u1", 5_000);
      await vi.advanceTimersByTimeAsync(1_000);
      endRuleSetExecution("u1");
      await vi.advanceTimersByTimeAsync(500);
      expect(await claim).toBe("claimed");
    });

    it("gives up after the wait", async () => {
      expect(tryBeginRuleSetExecution("u1")).toBe(true);
      const claim = beginQueryExecution("u1", 1_000);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await claim).toBe("rule-set-running");
    });

    it("answers another query run at once", async () => {
      expect(tryBeginQueryExecution("u1")).toBe("claimed");
      expect(await beginQueryExecution("u1", 5_000)).toBe("query-running");
    });
  });
});
