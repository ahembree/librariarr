// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";

const loaded = vi.hoisted(() => ({ sortableGrid: 0 }));
vi.mock("@/components/sortable-card-grid", async () => {
  loaded.sortableGrid += 1;
  return {
    SortableCardGrid: ({ cards }: { cards: { id: string }[] }) =>
      createElement("div", { "data-testid": "sortable" }, cards.map((c) => c.id).join(",")),
  };
});

import { DashboardCardGrid } from "@/components/dashboard-card-grid";

const noop = () => {};
const props = (editMode: boolean) => ({
  // Card ids the grid draws nothing for, so no card fetches.
  cards: [
    { id: "unknown-a", size: 6 },
    { id: "unknown-b", size: 6, heightPx: 300 },
  ],
  stats: {} as never,
  editMode,
  onLayoutChange: noop,
  onMovieClick: noop,
  onSeriesClick: noop,
  onArtistClick: noop,
  onEpisodeClick: noop,
  onTrackClick: noop,
});

describe("DashboardCardGrid", () => {
  it("draws a plain grid outside edit mode, without loading the drag-and-drop grid", async () => {
    const { container } = render(createElement(DashboardCardGrid, props(false)));
    const cells = container.querySelectorAll(".col-span-full");
    expect(cells).toHaveLength(2);
    expect((cells[1] as HTMLElement).style.height).toBe("300px");
    await new Promise((r) => setTimeout(r, 0));
    expect(loaded.sortableGrid).toBe(0);
  });

  it("loads the sortable grid once the user starts customizing, showing the cards meanwhile", async () => {
    const { container } = render(createElement(DashboardCardGrid, props(true)));
    // Until the module arrives the cards stay where they were.
    expect(container.querySelectorAll(".col-span-full")).toHaveLength(2);
    await waitFor(() => expect(screen.getByTestId("sortable").textContent).toBe("unknown-a,unknown-b"));
    expect(loaded.sortableGrid).toBe(1);
  });
});
