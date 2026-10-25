// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: () => ({ connected: true, authExpired: false }),
}));

import { ChipColorProvider, useChipColors } from "@/components/chip-color-provider";
import { useShellSettings } from "@/components/shell-settings-provider";
import { DEFAULT_CHIP_COLORS } from "@/lib/theme/chip-colors";
import type { ShellSettings } from "@/lib/settings/shell-settings-types";
import { shellSettingsWrapper } from "../../setup/shell-settings-wrapper";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The chip provider inside the shell's provider, as the authenticated layout nests them.
function inShell(overrides: Partial<ShellSettings> = {}) {
  const Shell = shellSettingsWrapper(overrides);
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(Shell, null, createElement(ChipColorProvider, null, children));
  };
}

function outsideShell({ children }: { children: ReactNode }) {
  return createElement(ChipColorProvider, null, children);
}

const putCalls = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");

describe("ChipColorProvider", () => {
  it("renders the shell's saved colours at once, without fetching", () => {
    const { result } = renderHook(() => useChipColors(), {
      wrapper: inShell({ chipColors: { resolution: { "4K": "#123456" } } }),
    });
    expect(result.current.getHex("resolution", "4K")).toBe("#123456");
    // Unsaved values keep their defaults.
    expect(result.current.colors.dynamicRange).toEqual(DEFAULT_CHIP_COLORS.dynamicRange);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the defaults when the shell found nothing saved", () => {
    const { result } = renderHook(() => useChipColors(), { wrapper: inShell({ chipColors: null }) });
    expect(result.current.colors).toEqual(DEFAULT_CHIP_COLORS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows the shell's store when another tab's colours are loaded", async () => {
    const { result } = renderHook(() => ({ chips: useChipColors(), store: useShellSettings()! }), {
      wrapper: inShell(),
    });
    await act(async () => {
      fetchMock.mockReset().mockResolvedValue({
        ok: true,
        json: async () => ({ ...result.current.store.getSnapshot(), chipColors: { resolution: { "4K": "#abcdef" } } }),
      });
      await result.current.store.refresh();
    });
    expect(result.current.chips.getHex("resolution", "4K")).toBe("#abcdef");
  });

  it("an edit updates the shell's store and saves", () => {
    const { result } = renderHook(() => ({ chips: useChipColors(), store: useShellSettings()! }), {
      wrapper: inShell(),
    });
    const edited = { ...DEFAULT_CHIP_COLORS, resolution: { ...DEFAULT_CHIP_COLORS.resolution, "4K": "#222222" } };
    act(() => result.current.chips.updateColors(edited));
    expect(result.current.chips.getHex("resolution", "4K")).toBe("#222222");
    expect(result.current.store.getSnapshot().chipColors).toBe(edited);
    expect(JSON.parse(putCalls()[0][1].body)).toEqual({ chipColors: edited });
  });

  it("fetches the colours outside the shell", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ chipColors: { resolution: { "4K": "#abcdef" } } }) });
    const { result } = renderHook(() => useChipColors(), { wrapper: outsideShell });
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/chip-colors");
    await waitFor(() => expect(result.current.getHex("resolution", "4K")).toBe("#abcdef"));
  });
});
