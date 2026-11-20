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
  it("sends a quoted query as typed, so the route matches the exact title", async () => {
    render(createElement(SearchPalette, { open: true, onOpenChange: () => {} }));
    expect(screen.getByText(/quotes for an exact title/i)).toBeTruthy();
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/search movies/i), { target: { value: '"ER"' } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const url = new URL(String(fetchMock.mock.calls[0][0]), "http://x");
    expect(url.searchParams.get("q")).toBe('"ER"');
  });

  describe("on a phone", () => {
    /** A visual viewport that a test can resize, as the iOS keyboard does. */
    function stubVisualViewport(height: number, offsetTop = 0) {
      const viewport = Object.assign(new EventTarget(), { height, offsetTop });
      vi.stubGlobal("visualViewport", viewport);
      return viewport;
    }

    it("sizes the palette to the visible viewport, and follows it as the keyboard opens", async () => {
      const viewport = stubVisualViewport(800);
      render(createElement(SearchPalette, { open: true, onOpenChange: () => {} }));
      const content = document.querySelector<HTMLElement>("[data-slot=dialog-content]")!;
      expect(content.style.getPropertyValue("--palette-height")).toBe("800px");
      expect(content.style.getPropertyValue("--palette-top")).toBe("0px");

      // The keyboard slides up over the bottom of the screen.
      await act(async () => {
        Object.assign(viewport, { height: 420, offsetTop: 12 });
        viewport.dispatchEvent(new Event("resize"));
      });
      expect(content.style.getPropertyValue("--palette-height")).toBe("420px");
      expect(content.style.getPropertyValue("--palette-top")).toBe("12px");
    });

    it("puts the keyboard away when the results are dragged", async () => {
      render(createElement(SearchPalette, { open: true, onOpenChange: () => {} }));
      const input = screen.getByPlaceholderText(/search movies/i);
      input.focus();
      expect(document.activeElement).toBe(input);
      fireEvent.touchMove(document.querySelector("[data-slot=command-list]")!, { touches: [{ clientX: 10, clientY: 10 }], changedTouches: [{ clientX: 10, clientY: 10 }] });
      expect(document.activeElement).not.toBe(input);
      expect((input as HTMLInputElement).value).toBe("");
    });

    it("closes from Cancel, since a phone has no Esc and nothing outside to tap", () => {
      const onOpenChange = vi.fn();
      render(createElement(SearchPalette, { open: true, onOpenChange }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
