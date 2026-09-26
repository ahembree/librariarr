import { describe, it, expect, beforeEach } from "vitest";
import {
  tryBeginExecute,
  endExecute,
  isExecuteInFlight,
  queryExecuteKey,
  _resetExecuteInFlightForTesting,
} from "@/lib/lifecycle/execute-in-flight";

describe("lifecycle execute single-flight registry", () => {
  beforeEach(() => _resetExecuteInFlightForTesting());

  it("claims a free key and refuses a second claim until it is released", () => {
    expect(tryBeginExecute("rs-1")).toBe(true);
    expect(isExecuteInFlight("rs-1")).toBe(true);
    expect(tryBeginExecute("rs-1")).toBe(false);
    endExecute("rs-1");
    expect(isExecuteInFlight("rs-1")).toBe(false);
    expect(tryBeginExecute("rs-1")).toBe(true);
  });

  it("keys are independent — another rule set is never blocked", () => {
    expect(tryBeginExecute("rs-1")).toBe(true);
    expect(tryBeginExecute("rs-2")).toBe(true);
    endExecute("rs-1");
    expect(isExecuteInFlight("rs-2")).toBe(true);
  });

  it("releasing an unheld key is a no-op and does not disturb a held one", () => {
    expect(tryBeginExecute("rs-1")).toBe(true);
    endExecute("rs-2");
    expect(isExecuteInFlight("rs-1")).toBe(true);
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
    expect(isExecuteInFlight("rs-1")).toBe(false);
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
    const g = globalThis as unknown as { lifecycleExecuteInFlight: Set<string> };
    expect(g.lifecycleExecuteInFlight.has("rs-1")).toBe(true);
  });
});
