// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const realtime = vi.hoisted(() => ({ handlers: new Map<string, () => void>() }));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (type: string, cb: () => void) => {
    realtime.handlers.set(type, cb);
    return { connected: true, authExpired: false };
  },
}));

import { useShellSettings, useShellSnapshot } from "@/components/shell-settings-provider";
import { SHELL_SETTINGS_URL } from "@/lib/settings/shell-settings-store";
import { SHELL_SETTINGS, shellSettingsWrapper } from "../../setup/shell-settings-wrapper";

const fetchMock = vi.fn();
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  realtime.handlers.clear();
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ ...SHELL_SETTINGS, user: { username: "renamed", authMethod: "Plex" } }),
  });
  vi.stubGlobal("fetch", fetchMock);
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

const shellRequests = () => fetchMock.mock.calls.filter(([url]) => url === SHELL_SETTINGS_URL);

describe("ShellSettingsProvider", () => {
  it("re-reads the settings when another tab saves one, and re-renders readers", async () => {
    const { result } = renderHook(() => useShellSnapshot(), { wrapper: shellSettingsWrapper() });
    expect(result.current?.user.username).toBe("server-admin");

    await act(async () => {
      realtime.handlers.get("display-settings:changed")!();
    });

    expect(shellRequests()).toHaveLength(1);
    expect(result.current?.user.username).toBe("renamed");
  });

  it("re-reads a tab that was hidden for a minute or more, not one hidden briefly", async () => {
    vi.useFakeTimers();
    renderHook(() => useShellSnapshot(), { wrapper: shellSettingsWrapper() });

    setVisibility("hidden");
    vi.advanceTimersByTime(30_000);
    await act(async () => setVisibility("visible"));
    expect(shellRequests()).toHaveLength(0);

    setVisibility("hidden");
    vi.advanceTimersByTime(60_000);
    await act(async () => setVisibility("visible"));
    expect(shellRequests()).toHaveLength(1);
  });

  it("hands a changed accent to the theme provider's event", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...SHELL_SETTINGS, accentColor: "violet" }) });
    const seen: string[] = [];
    const onAccent = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener("accent-color-changed", onAccent);
    renderHook(() => useShellSnapshot(), { wrapper: shellSettingsWrapper() });

    await act(async () => {
      realtime.handlers.get("display-settings:changed")!();
    });

    window.removeEventListener("accent-color-changed", onAccent);
    expect(seen).toEqual(["violet"]);
  });

  it("gives no store outside the shell, and its event does nothing", async () => {
    const { result } = renderHook(() => ({ store: useShellSettings(), snapshot: useShellSnapshot() }));
    expect(result.current).toEqual({ store: null, snapshot: null });
  });
});
