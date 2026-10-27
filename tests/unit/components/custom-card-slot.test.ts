// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, Fragment } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CustomCardConfig } from "@/lib/dashboard/card-registry";
import type { CustomCardData } from "@/lib/dashboard/custom-card-data";

// The chart itself (recharts) is not under test: a stand-in shows what the
// slot handed it, and offers the card's own type selector.
vi.mock("@/components/custom-chart-card", () => ({
  CustomChartCard: (props: {
    config: CustomCardConfig;
    loading: boolean;
    failed: boolean;
    data: CustomCardData | null;
    filterType?: string;
    onLocalFilterChange: (value: string) => void;
  }) =>
    createElement(
      "div",
      { "data-testid": `card-${props.config.chartType}-${props.config.dimension}-${props.config.dimension2 ?? ""}` },
      createElement("span", { "data-testid": "state" }, props.loading ? "loading" : props.failed ? "failed" : JSON.stringify(props.data)),
      createElement("span", { "data-testid": "type" }, props.filterType ?? "all"),
      createElement("button", { onClick: () => props.onLocalFilterChange("MOVIE") }, "movies"),
    ),
}));

import { CustomCardSlot } from "@/components/dashboard/custom-card-slot";

type Card = { kind: string; [key: string]: unknown };

const fetchMock = vi.fn();
/** The cards each batch POST carried. */
const batches = () => fetchMock.mock.calls.map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { cards: Card[] }).cards);
let answer: (card: Card) => { status: number; body: unknown };

beforeEach(() => {
  answer = (card) => ({ status: 200, body: card.kind === "crossTab" ? { rows: [] } : card.kind === "timeline" ? { points: [], series: [] } : { breakdown: [] } });
  fetchMock.mockReset().mockImplementation(async (url: string, init: RequestInit) => {
    if (url !== "/api/media/stats/custom-batch") throw new Error(`unexpected ${url}`);
    const { cards } = JSON.parse(String(init.body)) as { cards: Card[] };
    return new Response(JSON.stringify({ cards: cards.map((c) => answer(c)) }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const heatmap: CustomCardConfig = { chartType: "heatmap", dimension: "resolution", dimension2: "videoCodec" };
const timeline: CustomCardConfig = { chartType: "timeline", dimension: "addedAt", timelineBin: "year" };
const pie: CustomCardConfig = { chartType: "pie", dimension: "genre" };

describe("CustomCardSlot", () => {
  it("asks for every card's data in one request", async () => {
    render(
      createElement(
        Fragment,
        null,
        createElement(CustomCardSlot, { config: heatmap, serverId: "srv-1" }),
        createElement(CustomCardSlot, { config: timeline, serverId: "srv-1", availableTypes: ["MOVIE", "SERIES"] }),
        createElement(CustomCardSlot, { config: pie, serverId: "srv-1" }),
      ),
    );
    await waitFor(() => expect(screen.getAllByTestId("state").map((el) => el.textContent)).not.toContain("loading"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(batches()[0].map((c) => c.kind)).toEqual(["crossTab", "timeline", "custom"]);
    expect(screen.getByTestId("card-heatmap-resolution-videoCodec").querySelector('[data-testid="state"]')!.textContent).toBe(
      JSON.stringify({ kind: "crossTab", rows: [] }),
    );
  });

  it("shows a card whose route failed as failed, beside a card that loaded", async () => {
    answer = (card) =>
      card.kind === "crossTab" ? { status: 500, body: { error: "boom" } } : { status: 200, body: { breakdown: [{ value: "Drama", type: "MOVIE", _count: 2 }] } };
    render(
      createElement(
        Fragment,
        null,
        createElement(CustomCardSlot, { config: heatmap }),
        createElement(CustomCardSlot, { config: pie }),
      ),
    );
    const heat = () => screen.getByTestId("card-heatmap-resolution-videoCodec").querySelector('[data-testid="state"]')!.textContent;
    const genre = () => screen.getByTestId("card-pie-genre-").querySelector('[data-testid="state"]')!.textContent;
    await waitFor(() => expect(heat()).toBe("failed"));
    expect(genre()).toContain("Drama");
  });

  it("drops the previous config's data when the edited one fails", async () => {
    const { rerender } = render(createElement(CustomCardSlot, { config: heatmap }));
    const state = () => screen.getByTestId("state").textContent;
    await waitFor(() => expect(state()).toContain("crossTab"));

    answer = () => ({ status: 500, body: { error: "boom" } });
    rerender(createElement(CustomCardSlot, { config: { ...heatmap, dimension2: "audioCodec" } }));
    // Never the old heatmap under the new config while the new one loads…
    expect(state()).toBe("loading");
    // …nor after it fails.
    await waitFor(() => expect(state()).toBe("failed"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("applies an answer only to the request it was asked for", async () => {
    let release: (() => void) | undefined;
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      const { cards } = JSON.parse(String(init.body)) as { cards: Card[] };
      return new Response(JSON.stringify({ cards: cards.map(() => ({ status: 200, body: { breakdown: [{ value: "STALE", type: "MOVIE", _count: 1 }] } })) }), {
        status: 200,
      });
    });
    const { rerender } = render(createElement(CustomCardSlot, { config: pie, serverId: "srv-1" }));
    await waitFor(() => expect(release).toBeDefined());
    rerender(createElement(CustomCardSlot, { config: pie, serverId: "srv-2" }));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe(JSON.stringify({ kind: "custom", breakdown: [] })));
    await act(async () => {
      release!();
    });
    expect(screen.getByTestId("state").textContent).not.toContain("STALE");
  });

  it("asks a timeline again when its own type changes, and a breakdown never", async () => {
    render(
      createElement(
        Fragment,
        null,
        createElement(CustomCardSlot, { config: timeline, availableTypes: ["MOVIE", "SERIES"] }),
        createElement(CustomCardSlot, { config: pie, availableTypes: ["MOVIE", "SERIES"] }),
      ),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByTestId("state").map((el) => el.textContent)).not.toContain("loading"));

    const [timelineCard, pieCard] = [
      screen.getByTestId("card-timeline-addedAt-"),
      screen.getByTestId("card-pie-genre-"),
    ];
    await act(async () => {
      fireEvent.click(pieCard.querySelector("button")!);
    });
    // The breakdown is filtered on the card: nothing new is asked for.
    expect(pieCard.querySelector('[data-testid="type"]')!.textContent).toBe("MOVIE");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(timelineCard.querySelector("button")!);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(batches()[1]).toEqual([{ kind: "timeline", dateField: "addedAt", bin: "year", type: "MOVIE" }]);
  });

  it("follows the Insights type filter", async () => {
    const { rerender } = render(createElement(CustomCardSlot, { config: timeline, availableTypes: ["MOVIE", "SERIES"] }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(createElement(CustomCardSlot, { config: timeline, filterType: "SERIES", availableTypes: ["MOVIE", "SERIES"] }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(batches()[1][0]).toMatchObject({ type: "SERIES" });
  });
});
