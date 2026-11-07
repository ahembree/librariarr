// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { RowToneChip } from "@/components/row-tone-chip";
import { ROW_TONE_LABELS } from "@/lib/table-row-surface";

// The chip is what makes a diff tone readable without telling green from
// amber: a word and a distinct shape beside the colour.
describe("RowToneChip", () => {
  it.each(["added", "removed"] as const)("says %s in words, with its own icon and a full description", (tone) => {
    const { container } = render(createElement(RowToneChip, { tone }));
    const chip = container.querySelector(`[data-tone="${tone}"]`);
    expect(chip?.textContent).toBe(ROW_TONE_LABELS[tone].short);
    expect(chip?.getAttribute("title")).toBe(ROW_TONE_LABELS[tone].long);
    const icon = chip?.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("class")).toContain(tone === "added" ? "lucide-plus" : "lucide-minus");
  });

  it("lets a caller restyle the chip (a card puts it on a solid backdrop)", () => {
    const { container } = render(createElement(RowToneChip, { tone: "added", className: "absolute bg-background/90" }));
    const cls = container.querySelector("[data-tone]")?.getAttribute("class") ?? "";
    expect(cls).toContain("absolute");
    expect(cls).toContain("bg-background/90");
    expect(cls).not.toContain("bg-green-dim");
  });
});
