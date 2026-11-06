// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Stands in for every breakdown card: counts how often one is mounted and drawn.
const probe = vi.hoisted(() => ({ mounts: 0, renders: new Map<string, number>() }));
vi.mock("@/components/breakdown-chart", async () => {
  const { createElement: h, useEffect } = await import("react");
  return {
    BreakdownChart: function Probe({ title }: { title: string }) {
      probe.renders.set(title, (probe.renders.get(title) ?? 0) + 1);
      useEffect(() => {
        probe.mounts += 1;
      }, []);
      return h("div", { "data-testid": "probe" }, title);
    },
  };
});

import { DashboardCardGrid } from "@/components/dashboard-card-grid";
import { dashboardCardStyle } from "@/components/dashboard-card-cell";
import type { CardEntry } from "@/lib/dashboard/card-registry";

const noop = () => {};
const STATS = { videoCodecBreakdown: [], genreBreakdown: [], audioCodecBreakdown: [] } as never;
const CARDS: CardEntry[] = [
  { id: "video-codec", size: 6 },
  { id: "genre", size: 6, heightPx: 300 },
];
const handlers = {
  onLayoutChange: noop,
  onMovieClick: noop,
  onSeriesClick: noop,
  onArtistClick: noop,
  onEpisodeClick: noop,
  onTrackClick: noop,
};
const props = (over: Partial<Parameters<typeof DashboardCardGrid>[0]> = {}) => ({
  cards: CARDS,
  stats: STATS,
  editMode: false,
  ...handlers,
  ...over,
});
const renders = () => [...probe.renders.values()].reduce((a, b) => a + b, 0);

beforeEach(() => {
  probe.mounts = 0;
  probe.renders.clear();
});

describe("DashboardCardGrid cards", () => {
  it("stay mounted when the layout editor opens and closes", async () => {
    const { rerender, container } = render(createElement(DashboardCardGrid, props()));
    expect(probe.mounts).toBe(2);

    rerender(createElement(DashboardCardGrid, props({ editMode: true })));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Drag to move card" })).toHaveLength(2));
    // The same two cards, now inside the editor's frames.
    expect(probe.mounts).toBe(2);
    for (const card of screen.getAllByTestId("probe")) {
      expect(card.closest("div.border-dashed")).not.toBeNull();
    }

    rerender(createElement(DashboardCardGrid, props({ editMode: false })));
    expect(probe.mounts).toBe(2);
    expect(screen.getAllByTestId("probe")).toHaveLength(2);
    expect(container.querySelector("div.border-dashed")).toBeNull();
  });

  it("are not redrawn for a move, a resize or an equal copy of the layout", () => {
    const { rerender } = render(createElement(DashboardCardGrid, props()));
    const drawn = renders();

    rerender(createElement(DashboardCardGrid, props({ cards: [{ ...CARDS[1], size: 4 }, { ...CARDS[0] }] })));
    expect(renders()).toBe(drawn);
  });

  it("redraw only the card whose display choices changed", () => {
    const { rerender } = render(createElement(DashboardCardGrid, props()));
    const before = new Map(probe.renders);

    rerender(createElement(DashboardCardGrid, props({ cards: [{ ...CARDS[0], display: { view: "donut" } }, CARDS[1]] })));
    expect(probe.renders.get("Video Codec Breakdown")).toBe((before.get("Video Codec Breakdown") ?? 0) + 1);
    expect(probe.renders.get("Genre Breakdown")).toBe(before.get("Genre Breakdown"));
  });

  it("hand a removal to onCardRemove", async () => {
    const onCardRemove = vi.fn();
    render(createElement(DashboardCardGrid, props({ editMode: true, onCardRemove })));
    const remove = await screen.findAllByRole("button", { name: "Remove card" });
    await act(async () => {
      fireEvent.click(remove[1]);
    });
    expect(onCardRemove).toHaveBeenCalledWith("genre");
  });
});

describe("dashboardCardStyle", () => {
  it("spans the card's columns at its set height on a wider screen", () => {
    expect(dashboardCardStyle(6, 300, false)).toEqual({ gridColumn: "span 6", height: 300 });
    expect(dashboardCardStyle(4, undefined, false)).toEqual({ gridColumn: "span 4" });
  });

  it("leaves a card its content's height on a phone", () => {
    expect(dashboardCardStyle(6, 300, true)).toEqual({});
  });
});
