// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useCardDisplay, TOGGLE_CONFIGS, SEASON_EPISODE_TOGGLES } from "@/hooks/use-card-display";

const KEY = "card-display-preferences";
const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ json: async () => ({}) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const putCalls = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");

describe("useCardDisplay", () => {
  it("uses the type's defaults and treats unknown keys as shown", () => {
    const { result } = renderHook(() => useCardDisplay("MOVIE"));
    expect(result.current.show("badges", "resolution")).toBe(true);
    expect(result.current.show("metadata", "year")).toBe(true);
    // audioProfile is offered but has no default entry — shown.
    expect(result.current.show("badges", "audioProfile")).toBe(true);
    expect(result.current.showServers).toBe(true);
  });

  it("merges stored preferences over the defaults", () => {
    localStorage.setItem(KEY, JSON.stringify({ MOVIE: { badges: { resolution: false }, metadata: {}, servers: false } }));
    const { result } = renderHook(() => useCardDisplay("MOVIE"));
    expect(result.current.show("badges", "resolution")).toBe(false);
    expect(result.current.show("badges", "dynamicRange")).toBe(true);
    expect(result.current.showServers).toBe(false);
    expect(result.current.prefs.metadata).toEqual({ year: true, duration: true, fileSize: true });
  });

  it("falls back to the default servers flag when a stored entry omits it", () => {
    localStorage.setItem(KEY, JSON.stringify({ SERIES: { badges: {}, metadata: {} } }));
    const { result } = renderHook(() => useCardDisplay("SERIES"));
    expect(result.current.showServers).toBe(true);
  });

  it("ignores corrupt localStorage", () => {
    localStorage.setItem(KEY, "{nope");
    const { result } = renderHook(() => useCardDisplay("MUSIC"));
    expect(result.current.show("metadata", "albumCount")).toBe(true);
  });

  it("hydrates from the API when nothing is stored locally", async () => {
    const preferences = { MOVIE: { badges: { resolution: false }, metadata: {}, servers: true } };
    fetchMock.mockResolvedValue({ json: async () => ({ preferences }) });
    const { result } = renderHook(() => useCardDisplay("MOVIE"));
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/card-display-preferences");
    await waitFor(() => expect(result.current.show("badges", "resolution")).toBe(false));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(preferences);
  });

  it("keeps local preferences over the API's", async () => {
    localStorage.setItem(KEY, JSON.stringify({ MOVIE: { badges: { resolution: true }, metadata: {}, servers: true } }));
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useCardDisplay("MOVIE"));
    await act(async () => {
      resolve({ json: async () => ({ preferences: { MOVIE: { badges: { resolution: false }, metadata: {}, servers: true } } }) });
    });
    expect(result.current.show("badges", "resolution")).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!).MOVIE.badges.resolution).toBe(true);
  });

  it("swallows a failed hydration", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useCardDisplay("MOVIE"));
    await act(async () => {});
    expect(result.current.show("badges", "resolution")).toBe(true);
  });

  it("setVisible writes locally at once and syncs to the API once, debounced", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCardDisplay("SERIES_EPISODES"));
    await act(async () => {});

    act(() => result.current.setVisible("badges", "resolution", false));
    act(() => result.current.setVisible("metadata", "episodeTitle", false));
    act(() => result.current.setVisible("servers", "", false));

    expect(result.current.show("badges", "resolution")).toBe(false);
    expect(result.current.show("metadata", "episodeTitle")).toBe(false);
    expect(result.current.show("metadata", "duration")).toBe(true);
    expect(result.current.showServers).toBe(false);
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.SERIES_EPISODES.servers).toBe(false);
    expect(stored.SERIES_EPISODES.badges.resolution).toBe(false);

    act(() => vi.advanceTimersByTime(999));
    expect(putCalls()).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(putCalls()).toHaveLength(1);
    const [url, init] = putCalls()[0];
    expect(url).toBe("/api/settings/card-display-preferences");
    expect(JSON.parse(init.body)).toEqual({ preferences: stored });
  });

  it("keeps other library types' preferences when one type changes", () => {
    localStorage.setItem(KEY, JSON.stringify({ MUSIC: { badges: { audioCodecs: false }, metadata: {}, servers: true } }));
    const { result } = renderHook(() => useCardDisplay("MOVIE"));
    act(() => result.current.setVisible("metadata", "year", false));
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.MUSIC.badges.audioCodecs).toBe(false);
    expect(stored.MOVIE.metadata.year).toBe(false);
  });

  it("keeps `show` stable across renders while preferences are unchanged", () => {
    const { result, rerender } = renderHook(() => useCardDisplay("MOVIE"));
    const show = result.current.show;
    rerender();
    expect(result.current.show).toBe(show);
  });

  it("offers the SxxExx label on a season grid and the episode title on All Episodes", () => {
    expect(SEASON_EPISODE_TOGGLES.metadata.map((m) => m.key)).toContain("episodeLabel");
    expect(SEASON_EPISODE_TOGGLES.metadata.map((m) => m.key)).not.toContain("episodeTitle");
    expect(TOGGLE_CONFIGS.SERIES_EPISODES.metadata.map((m) => m.key)).toContain("episodeTitle");
    expect(SEASON_EPISODE_TOGGLES.badges).toBe(TOGGLE_CONFIGS.SERIES_EPISODES.badges);
  });
});
