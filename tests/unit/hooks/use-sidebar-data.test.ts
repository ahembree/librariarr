// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(),
  push: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (type: string, cb: () => void) => {
    mocks.handlers.set(type, cb);
    return { connected: true, authExpired: false };
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

import { useSidebarData } from "@/hooks/use-sidebar-data";

type Responses = Record<string, unknown>;
const fetchMock = vi.fn();
let responses: Responses;
let sessionsQueue: unknown[];

function json(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: async () => body });
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.push.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  responses = {
    "/api/media/library-types": { types: ["MOVIE", "SERIES", "MUSIC"], allTypes: ["MOVIE", "SERIES", "MUSIC"] },
    "/api/system/update-check": { updateAvailable: false },
    "/api/auth/me": { username: "admin", authMethod: "local" },
    "/api/auth/logout": {},
  };
  sessionsQueue = [];
  fetchMock.mockReset().mockImplementation((url: string) => {
    if (url === "/api/tools/sessions") return json(sessionsQueue.shift() ?? { sessions: [] });
    if (url in responses) return json(responses[url]);
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  document.cookie = "sidebar-collapsed=; max-age=0; path=/";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const items = (nav: { label: string; items: { name: string }[] }[], label: string) =>
  nav.find((g) => g.label === label)?.items.map((i) => i.name);

describe("useSidebarData", () => {
  it("builds the full navigation and loads the user", async () => {
    const { result } = renderHook(() => useSidebarData());
    await waitFor(() => expect(result.current.user).toEqual({ username: "admin", authMethod: "local" }));
    const nav = result.current.navigation;
    expect(nav.map((g) => g.label)).toEqual(["Overview", "Library", "Lifecycle", "Tools", "System"]);
    expect(items(nav, "Library")).toEqual(["Movies", "Series", "Music", "History", "Query"]);
    expect(items(nav, "Lifecycle")).toEqual(["Rules", "Rule Matches", "Pending Actions", "Exceptions"]);
  });

  it("drops a library type nobody has and warns on a known type with no enabled library", async () => {
    responses["/api/media/library-types"] = { types: ["MOVIE"], allTypes: ["MOVIE", "SERIES"] };
    const { result } = renderHook(() => useSidebarData());
    await waitFor(() => expect(items(result.current.navigation, "Library")).toEqual(["Movies", "Series", "History", "Query"]));
    const lib = result.current.navigation.find((g) => g.label === "Library")!.items;
    expect(lib.find((i) => i.name === "Movies")!.warning).toBe(false);
    expect(lib.find((i) => i.name === "Series")!.warning).toBe(true);
  });

  it("keeps every type when the server reports none", async () => {
    responses["/api/media/library-types"] = { types: [], allTypes: [] };
    const { result } = renderHook(() => useSidebarData());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/media/library-types"));
    await act(async () => {});
    expect(items(result.current.navigation, "Library")).toContain("Music");
  });

  it("refetches library types on server:changed and sync:completed", async () => {
    renderHook(() => useSidebarData());
    await act(async () => {});
    const count = () => fetchMock.mock.calls.filter(([u]) => u === "/api/media/library-types").length;
    expect(count()).toBe(1);
    await act(async () => mocks.handlers.get("server:changed")!());
    await act(async () => mocks.handlers.get("sync:completed")!());
    expect(count()).toBe(3);
  });

  it("shows the update dot with its version, fetched at low priority", async () => {
    responses["/api/system/update-check"] = { updateAvailable: true, latestVersion: "2.1.0" };
    const { result } = renderHook(() => useSidebarData());
    await waitFor(() => {
      const settings = result.current.navigation.find((g) => g.label === "System")!.items[0];
      expect(settings.dot).toBe(true);
      expect(settings.dotTooltip).toBe("Update available: v2.1.0");
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/system/update-check", { priority: "low" });
    expect(fetchMock).toHaveBeenCalledWith("/api/tools/sessions", { priority: "low" });
  });

  it("leaves the user null when /api/auth/me is refused", async () => {
    fetchMock.mockImplementation((url: string) =>
      url === "/api/auth/me" ? json({ username: "x" }, false) : json({}),
    );
    const { result } = renderHook(() => useSidebarData());
    await act(async () => {});
    expect(result.current.user).toBeNull();
  });

  it("badges the stream count and refreshes it on session-changed and server-status", async () => {
    sessionsQueue = [{ sessions: [1, 2] }, { sessions: [1, 2, 3] }, { sessions: [] }];
    const { result } = renderHook(() => useSidebarData());
    const streams = () => result.current.navigation.find((g) => g.label === "Tools")!.items[0].badge;
    await waitFor(() => expect(streams()).toBe(2));
    await act(async () => mocks.handlers.get("session-changed")!());
    expect(streams()).toBe(3);
    await act(async () => mocks.handlers.get("server-status")!());
    expect(streams()).toBe(0);
  });

  it("toasts a server going down and coming back, once each, and broadcasts health", async () => {
    const health = vi.fn();
    window.addEventListener("server-health-changed", health);
    const down = { id: "s1", name: "Plex", type: "PLEX" };
    sessionsQueue = [{ sessions: [], unreachableServers: [down] }, { sessions: [], unreachableServers: [down] }, { sessions: [] }];
    renderHook(() => useSidebarData());
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith("Plex is unreachable", expect.objectContaining({ id: "server-down-s1" }));
    expect((health.mock.calls[0][0] as CustomEvent).detail).toEqual({ unreachable: [down] });

    await act(async () => mocks.handlers.get("session-changed")!());
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    await act(async () => mocks.handlers.get("session-changed")!());
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Plex is back online", { id: "server-up-s1" });
    expect((health.mock.calls.at(-1)![0] as CustomEvent).detail).toEqual({ unreachable: [] });
    window.removeEventListener("server-health-changed", health);
  });

  it("logs a failed session fetch instead of throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockImplementation((url: string) =>
      url === "/api/tools/sessions" ? Promise.reject(new Error("down")) : json({}),
    );
    renderHook(() => useSidebarData());
    await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to fetch session count", expect.any(Error)));
  });

  it("falls back to a 5-minute session poll and stops it on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSidebarData());
    const count = () => fetchMock.mock.calls.filter(([u]) => u === "/api/tools/sessions").length;
    expect(count()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299_999);
    });
    expect(count()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(count()).toBe(2);
    unmount();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(count()).toBe(2);
  });

  it("persists the collapsed state in a cookie", async () => {
    const { result } = renderHook(() => useSidebarData(true));
    expect(result.current.collapsed).toBe(true);
    expect(document.cookie).toContain("sidebar-collapsed=1");
    act(() => result.current.setCollapsed(false));
    expect(document.cookie).toContain("sidebar-collapsed=0");
  });

  it("logs out with a POST and goes to /login", async () => {
    const { result } = renderHook(() => useSidebarData());
    await act(async () => {
      await result.current.handleLogout();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    expect(mocks.push).toHaveBeenCalledWith("/login");
  });
});
