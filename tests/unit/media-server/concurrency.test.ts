import { describe, it, expect } from "vitest";
import { mapWithConcurrency, settleWithConcurrency } from "@/lib/media-server/concurrency";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("mapWithConcurrency", () => {
  it("returns results in input order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 3, async (n, i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, n));
      inFlight--;
      return `${i}:${n}`;
    });
    expect(result).toEqual(["0:5", "1:1", "2:4", "3:2", "4:3", "5:0"]);
    expect(peak).toBe(3);
  });

  it("starts the next item as soon as any slot frees, not after the whole wave", async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const started: number[] = [];
    const run = mapWithConcurrency([0, 1, 2], 2, async (i) => {
      started.push(i);
      await gates[i].promise;
      return i;
    });
    await tick();
    expect(started).toEqual([0, 1]);
    // Item 1 finishes while item 0 is still slow: item 2 must start now.
    gates[1].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[0].resolve();
    gates[2].resolve();
    expect(await run).toEqual([0, 1, 2]);
  });

  it("rethrows the first failure and starts nothing after it", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4], 2, async (i) => {
        started.push(i);
        await tick();
        if (i === 1) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
    // 0 and 1 ran together; 1 failed, and only the item already handed to the
    // other slot (2) may have started — nothing past it.
    expect(started.length).toBeLessThanOrEqual(3);
    expect(started).not.toContain(4);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 10, async (n) => n * 2)).toEqual([2, 4]);
    expect(await mapWithConcurrency([1, 2], 0, async (n) => n)).toEqual([1, 2]);
  });
});

describe("settleWithConcurrency", () => {
  it("runs every item and reports each outcome in order", async () => {
    const outcomes = await settleWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("two");
      return n;
    });
    expect(outcomes[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(outcomes[1].status).toBe("rejected");
    expect((outcomes[1] as PromiseRejectedResult).reason).toEqual(new Error("two"));
    expect(outcomes[2]).toEqual({ status: "fulfilled", value: 3 });
  });
});
