import { describe, it, expect } from "vitest";
import { cardLabel } from "@/lib/dashboard/card-label";

describe("cardLabel", () => {
  it("names a built-in card by its definition", () => {
    expect(cardLabel({ id: "quality-breakdown" })).toBe("Quality Breakdown");
    expect(cardLabel({ id: "no-such-card" })).toBe("Card");
  });

  it("names a custom card by its title, or after its chart", () => {
    expect(cardLabel({ id: "custom-1", config: { chartType: "bar", dimension: "year", title: "Years" } })).toBe("Years");
    expect(cardLabel({ id: "custom-1", config: { chartType: "count", dimension: "resolution" } })).toBe("Resolution Count");
    expect(cardLabel({ id: "custom-1" })).toBe("Custom Card");
  });
});
