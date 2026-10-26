// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderHook, waitFor, act, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  search: new URLSearchParams(),
  ticks: [] as { types: readonly string[]; cb: () => void }[],
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => mocks.search }));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtimeEvents: (types: readonly string[], cb: () => void) => {
    mocks.ticks.push({ types, cb });
    return { connected: true, authExpired: false };
  },
}));

import { useMediaDetailRecord, useBackOverride } from "@/hooks/use-media-detail-record";
import { DetailPageStates, RatingChips, GenreChips, genreChips } from "@/components/media-detail-parts";
import { detailPrefetch } from "@/lib/media/detail-prefetch";

const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const urls = () => fetchMock.mock.calls.map(([u]) => u);
const tick = (type: string) => act(() => mocks.ticks.filter((t) => t.types.includes(type)).at(-1)!.cb());

beforeEach(() => {
  mocks.search = new URLSearchParams();
  mocks.ticks = [];
  detailPrefetch.clear();
  fetchMock.mockReset().mockImplementation((url: string) =>
    Promise.resolve(
      ok(
        /^\/api\/media\/[^/?]+$/.test(url)
          ? {
              item: { id: url.split("/").pop(), title: "Thing" },
              playServers: [{ serverId: "s", serverName: "Plex", serverType: "PLEX", ratingKey: "1", parentRatingKey: "2" }],
            }
          : {},
      ),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useMediaDetailRecord", () => {
  it("starts the page's id-keyed requests with the record, asking for the record once", async () => {
    const { result } = renderHook(() => useMediaDetailRecord("m1", { mediaType: "MOVIE", plays: true }));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.item?.id).toBe("m1"));
    expect(result.current.loading).toBe(false);
    expect(urls()).toEqual([
      "/api/media/m1",
      "/api/media/m1/arr-info",
      "/api/media/m1/seerr-info",
      "/api/media/m1/plays?page=1&limit=5",
    ]);
    expect(result.current.playServers).toHaveLength(1);
  });

  it("builds the play links it is given", async () => {
    const { result } = renderHook(() =>
      useMediaDetailRecord("e1", {
        mediaType: "SERIES",
        plays: false,
        playLinks: [
          ["Episode", "ratingKey"],
          ["Season", "parentRatingKey"],
        ],
      }),
    );
    await waitFor(() => expect(result.current.item).not.toBeNull());
    expect(result.current.playServers.length).toBeGreaterThan(0);
    expect(urls()).not.toContain("/api/media/e1/plays?page=1&limit=5");
  });

  it("ticks on its events, re-reading the record only when told to", async () => {
    const movie = renderHook(() =>
      useMediaDetailRecord("m1", { mediaType: "MOVIE", plays: true, tickOn: ["sync:completed", "watch-history:updated"] }),
    );
    await waitFor(() => expect(movie.result.current.item).not.toBeNull());
    const records = () => urls().filter((u) => u === "/api/media/m1").length;
    expect(records()).toBe(1);
    tick("watch-history:updated");
    expect(movie.result.current.syncTick).toBe(1);
    await act(async () => {});
    expect(records()).toBe(1);

    const episode = renderHook(() =>
      useMediaDetailRecord("e1", { mediaType: "SERIES", plays: false, refetchOnTick: true }),
    );
    await waitFor(() => expect(episode.result.current.item).not.toBeNull());
    const episodeReads = () => urls().filter((u) => u === "/api/media/e1").length;
    expect(episodeReads()).toBe(1);
    tick("sync:completed");
    await waitFor(() => expect(episodeReads()).toBe(2));
    // The id-keyed prefetches are not started again for a tick.
    expect(urls().filter((u) => u === "/api/media/e1/arr-info")).toHaveLength(1);
  });

  it("does not tick for a sync of another library type", async () => {
    const { result } = renderHook(() =>
      useMediaDetailRecord("m1", { mediaType: "MOVIE", plays: true, tickOn: ["sync:completed", "watch-history:updated"] }),
    );
    await waitFor(() => expect(result.current.item).not.toBeNull());
    const fire = (data: Record<string, unknown>) =>
      act(() => (mocks.ticks.at(-1)!.cb as (d: Record<string, unknown>) => void)(data));
    fire({ timestamp: 1, serverId: "s1", libraryTypes: ["MUSIC"] });
    expect(result.current.syncTick).toBe(0);
    fire({ timestamp: 2, serverId: "s1", libraryTypes: ["MOVIE", "MUSIC"] });
    expect(result.current.syncTick).toBe(1);
    // Plays moving carry no library types, nor does a resync.
    fire({ timestamp: 3, serverId: "s1", imported: 4 });
    fire({});
    expect(result.current.syncTick).toBe(3);
  });

  it("starts the child list with the record, and no integration lookups when the page shows none", async () => {
    const { result } = renderHook(() =>
      useMediaDetailRecord("a1", { mediaType: "MUSIC", plays: false, integrations: false, children: "albums" }),
    );
    await waitFor(() => expect(result.current.item?.id).toBe("a1"));
    expect(urls().sort()).toEqual(["/api/media/a1", "/api/media/music/albums?itemId=a1"].sort());
    // Left for the page's child read to take, not asked for twice.
    expect(detailPrefetch.take("/api/media/music/albums?itemId=a1")).not.toBeNull();
  });

  it("leaves the item null when there is none, and stops loading", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "Not found" }) });
    const { result } = renderHook(() => useMediaDetailRecord("gone", { mediaType: "MOVIE", plays: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.item).toBeNull();
  });

  it("never shows an earlier id's record for a later one", async () => {
    const answers = new Map<string, () => void>();
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise((resolve) => {
          if (!/^\/api\/media\/[^/?]+$/.test(url)) return resolve(ok({}));
          answers.set(url, () => resolve(ok({ item: { id: url.split("/").pop(), title: "T" } })));
        }),
    );
    const { result, rerender } = renderHook(({ id }) => useMediaDetailRecord(id, { mediaType: "MOVIE", plays: false }), {
      initialProps: { id: "a" },
    });
    rerender({ id: "b" });
    await act(async () => answers.get("/api/media/b")!());
    await act(async () => answers.get("/api/media/a")!());
    expect(result.current.item?.id).toBe("b");
  });
});

describe("useBackOverride", () => {
  const LABELS = { "/library/series/episodes": "All Episodes" };

  it("follows a listed `from`, and nothing else", () => {
    mocks.search = new URLSearchParams("from=/library/series/episodes");
    expect(renderHook(() => useBackOverride(LABELS)).result.current).toEqual({
      href: "/library/series/episodes",
      label: "All Episodes",
    });
    mocks.search = new URLSearchParams("from=https://evil.example");
    expect(renderHook(() => useBackOverride(LABELS)).result.current).toBeNull();
    mocks.search = new URLSearchParams();
    expect(renderHook(() => useBackOverride(LABELS)).result.current).toBeNull();
  });
});

describe("detail page parts", () => {
  it("shows the skeleton while loading, then the not-found line", () => {
    const { container, rerender } = render(createElement(DetailPageStates, { loading: true, notFoundLabel: "Movie not found" }));
    expect(container.querySelectorAll("[data-slot='skeleton'], .animate-pulse").length).toBeGreaterThan(0);
    expect(screen.queryByText("Movie not found")).toBeNull();
    rerender(createElement(DetailPageStates, { loading: false, notFoundLabel: "Movie not found" }));
    expect(screen.getByText("Movie not found")).toBeTruthy();
  });

  it("labels each rating the item has", () => {
    render(
      createElement(RatingChips, {
        item: { rating: 8.1, audienceRating: null, userRating: 7, library: { mediaServer: { type: "JELLYFIN" } } },
      }),
    );
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getAllByText(/\d/).length).toBeGreaterThanOrEqual(2);
  });

  it("chips every genre, and hands the hero nothing for none", () => {
    render(createElement(GenreChips, { genres: ["Drama", "Sci-Fi"] }));
    expect(screen.getByText("Drama")).toBeTruthy();
    expect(screen.getByText("Sci-Fi")).toBeTruthy();
    expect(genreChips([])).toBeUndefined();
    expect(genreChips(null)).toBeUndefined();
    expect(genreChips(["Drama"])).toBeDefined();
  });
});
