// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { SearchPalette } from "@/components/search-palette";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  // cmdk scrolls the selected item into view; happy-dom has no layout.
  Element.prototype.scrollIntoView ??= () => {};
  fetchMock.mockReset().mockImplementation(async () =>
    new Response(
      JSON.stringify({
        results: {
          MOVIE: [
            { id: "m1", title: "Alien", year: 1979, type: "MOVIE", scope: "individual" },
            // A second server's copy of the same film.
            { id: "m2", title: "Alien", year: 1979, type: "MOVIE", scope: "individual" },
          ],
          SERIES: [{ id: "s1", title: "Alien Worlds", type: "SERIES", scope: "series", itemCount: 4 }],
          MUSIC: [
            { id: "a1", title: "Alien Ant Farm", type: "MUSIC", scope: "artist", itemCount: 12 },
            { id: "b1", title: "Alien Lanes", parentTitle: "Guided by Voices", type: "MUSIC", scope: "album", itemCount: 28 },
          ],
        },
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SearchPalette", () => {
  it("searches every type in one request per query and lists each group", async () => {
    render(createElement(SearchPalette, { open: true, onOpenChange: () => {} }));
    const input = screen.getByPlaceholderText(/search movies, series, artists, albums/i);
    await act(async () => {
      fireEvent.change(input, { target: { value: "alien" } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]), "http://x");
    expect(url.pathname).toBe("/api/media/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "alien",
      types: "MOVIE,SERIES,MUSIC",
      seriesScope: "true",
      musicScope: "true",
    });

    // Two servers' copies of one film are one result.
    expect(screen.getAllByText("Alien")).toHaveLength(1);
    expect(screen.getByText("Alien Worlds")).toBeTruthy();
    expect(screen.getByText("Alien Ant Farm")).toBeTruthy();
    expect(screen.getByText("Alien Lanes")).toBeTruthy();
  });

  it("shows no matches when the search fails", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    render(createElement(SearchPalette, { open: true, onOpenChange: () => {} }));
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/search movies/i), { target: { value: "alien" } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByText(/No matches for/)).toBeTruthy();
  });
});
