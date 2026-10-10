import { describe, it, expect } from "vitest";
import { resolveColumnWidth } from "@/hooks/use-column-resize";

describe("resolveColumnWidth", () => {
  it("uses the stored width, else the default", () => {
    expect(resolveColumnWidth({ id: "a", defaultWidth: 100 }, undefined)).toBe(100);
    expect(resolveColumnWidth({ id: "a", defaultWidth: 100 }, 180)).toBe(180);
  });

  it("never goes below the column's minimum, so a header title cannot overflow it", () => {
    // Default narrower than the title.
    expect(resolveColumnWidth({ id: "a", defaultWidth: 110, minWidth: 196 }, undefined)).toBe(196);
    // A width the user stored before (or dragged below) the title's width.
    expect(resolveColumnWidth({ id: "a", defaultWidth: 110, minWidth: 196 }, 90)).toBe(196);
    // Wider than the minimum: left alone.
    expect(resolveColumnWidth({ id: "a", defaultWidth: 110, minWidth: 196 }, 300)).toBe(300);
  });
});
