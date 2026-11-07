// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { MediaTable } from "@/components/media-table";
import type { MediaListItem } from "@/lib/types";
import type { RowTone } from "@/lib/table-row-surface";

const TITLES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];
const items = TITLES.map((title, i) => ({
  id: `m${i}`,
  title,
  parentTitle: null,
  type: "MOVIE",
  year: 2000 + i,
}) as unknown as MediaListItem);

// A run of three additions side by side, then a plain row, then a removal.
const TONES: Record<string, RowTone> = { m1: "added", m2: "added", m3: "added", m5: "removed" };

beforeEach(() => {
  // Outside the shell the table reads its saved columns itself.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  // happy-dom lays nothing out; the virtualizer renders only the rows that fit
  // its scroll element, so give every element a viewport-sized box.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderTable() {
  return render(
    createElement(
      "main",
      { style: { overflowY: "auto", height: "800px" } },
      createElement(MediaTable<MediaListItem>, {
        items,
        onItemClick: () => {},
        mediaType: "MOVIE",
        rowTone: (item: MediaListItem) => TONES[item.id],
      }),
    ),
  );
}

describe("MediaTable row tones", () => {
  it("gives every toned row its fill and a word for its state, and stripes the rest by index", () => {
    const { container } = renderTable();
    const rows = [...container.querySelectorAll<HTMLTableRowElement>("tbody tr[data-index]")];
    expect(rows).toHaveLength(items.length);

    for (const row of rows) {
      const index = Number(row.dataset.index);
      const tone = TONES[items[index].id];
      const cls = row.className.split(/\s+/);
      const chip = row.querySelector("[data-tone]");
      expect(cls.some((c) => c.startsWith("even:") || c.startsWith("odd:"))).toBe(false);
      if (tone === "added") {
        expect(cls).toContain("bg-green-dim");
        expect(chip?.textContent).toBe("New");
      } else if (tone === "removed") {
        expect(cls).toContain("bg-amber-dim");
        expect(chip?.textContent).toBe("Removed");
      } else {
        expect(chip).toBeNull();
        expect(cls.includes("bg-white/1.5")).toBe(index % 2 === 1);
      }
      if (tone) {
        // Neither a stripe nor a hover fill (TableRow's own `hover:bg-muted/50`
        // included) may replace the tone's fill.
        const fill = tone === "added" ? "bg-green-dim" : "bg-amber-dim";
        expect(cls.some((c) => c.startsWith("bg-white"))).toBe(false);
        expect(cls.filter((c) => c.startsWith("hover:bg-"))).toEqual([`hover:${fill}`]);
      }
    }
  });
});
