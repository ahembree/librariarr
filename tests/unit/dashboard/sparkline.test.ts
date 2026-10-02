import { describe, it, expect } from "vitest";
import { buildSparkPoints, extendToCurrentMonth } from "@/lib/dashboard/sparkline";

// Mid-month, local time, so the current bucket is unambiguous in any TZ.
const NOW = new Date(2026, 9, 15); // 2026-10

describe("extendToCurrentMonth", () => {
  it("pads months after the last addition with zero additions", () => {
    const out = extendToCurrentMonth(
      [
        { date: "2026-06", total: 3 },
        { date: "2026-07", total: 5 },
      ],
      false,
      NOW,
    );
    expect(out).toEqual([
      { date: "2026-06", total: 3 },
      { date: "2026-07", total: 5 },
      { date: "2026-08", total: 0 },
      { date: "2026-09", total: 0 },
      { date: "2026-10", total: 0 },
    ]);
  });

  it("carries the last value forward for a running total", () => {
    const out = extendToCurrentMonth([{ date: "2026-08", total: 900 }], true, NOW);
    expect(out.map((p) => p.total)).toEqual([900, 900, 900]);
    expect(out.at(-1)?.date).toBe("2026-10");
  });

  it("crosses a year boundary", () => {
    const out = extendToCurrentMonth([{ date: "2025-11", total: 1 }], false, new Date(2026, 1, 10));
    expect(out.map((p) => p.date)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("leaves a series already at the current month unchanged", () => {
    const pts = [{ date: "2026-10", total: 2 }];
    expect(extendToCurrentMonth(pts, false, NOW)).toEqual(pts);
  });

  it("does not add months when the last bucket is ahead of the browser clock", () => {
    // The DB buckets in its own timezone, so it can already be next month there.
    const pts = [{ date: "2026-11", total: 2 }];
    expect(extendToCurrentMonth(pts, false, NOW)).toEqual(pts);
  });

  it("leaves an empty series empty", () => {
    expect(extendToCurrentMonth([], false, NOW)).toEqual([]);
  });

  it("leaves a malformed label alone", () => {
    const pts = [{ date: "garbage", total: 1 }];
    expect(extendToCurrentMonth(pts, false, NOW)).toEqual(pts);
  });
});

describe("buildSparkPoints", () => {
  it("windows the last N calendar months ending now, not at the last addition", () => {
    // Additions stopped in 2025-01: the window must be 2025-11..2026-10, all zero.
    const raw = Array.from({ length: 13 }, (_, i) => ({
      date: `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
      total: 10,
    }));
    const out = buildSparkPoints(raw, { cumulative: false, months: 12, now: NOW });
    expect(out).toHaveLength(12);
    expect(out[0].date).toBe("2025-11");
    expect(out.at(-1)?.date).toBe("2026-10");
    expect(out.every((p) => p.total === 0)).toBe(true);
  });

  it("accumulates over the full history before slicing", () => {
    const raw = [
      { date: "2026-07", total: 100 },
      { date: "2026-08", total: 50 },
      { date: "2026-09", total: 25 },
    ];
    const out = buildSparkPoints(raw, { cumulative: true, months: 2, now: NOW });
    // Window 2026-09..2026-10; values are sizes AT that month, and the last
    // point equals the headline total.
    expect(out).toEqual([
      { date: "2026-09", total: 175 },
      { date: "2026-10", total: 175 },
    ]);
  });

  it("strips extra fields from the API points", () => {
    const out = buildSparkPoints(
      [{ date: "2026-10", total: 1, breakdown: { a: 1 } } as { date: string; total: number }],
      { cumulative: false, months: 12, now: NOW },
    );
    expect(out).toEqual([{ date: "2026-10", total: 1 }]);
  });
});
