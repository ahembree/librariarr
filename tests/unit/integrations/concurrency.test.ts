import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "@/lib/integrations/concurrency";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("mapWithConcurrency", () => {
  it("keeps results in input order", async () => {
    const out = await mapWithConcurrency([30, 10, 20], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:10", "2:20"]);
  });

  it("never runs more than the limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  it("returns an empty list for no items", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it("rejects on the first failure and starts nothing after it", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (n) => {
        started.push(n);
        await tick();
        if (n === 1) throw new Error("down");
      }),
    ).rejects.toThrow("down");
    // 0 and 1 started together; 2 started when 0 finished, then 1 failed.
    expect(started).toEqual([0, 1, 2]);
  });
});
