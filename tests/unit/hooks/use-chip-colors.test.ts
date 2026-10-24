// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { ChipColorProvider, useChipColors } from "@/components/chip-color-provider";
import { DEFAULT_CHIP_COLORS } from "@/lib/theme/chip-colors";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrapperWith(initialColors?: Parameters<typeof ChipColorProvider>[0]["initialColors"]) {
  return function Wrapper({ children }: { children: ReactNode }) {
    // The props type requires `children`, which lint wants as the third argument.
    const props = { initialColors } as Parameters<typeof ChipColorProvider>[0];
    return createElement(ChipColorProvider, props, children);
  };
}

describe("ChipColorProvider", () => {
  it("renders the server layout's saved colours at once, without fetching", () => {
    const { result } = renderHook(() => useChipColors(), {
      wrapper: wrapperWith({ resolution: { "4K": "#123456" } }),
    });
    expect(result.current.getHex("resolution", "4K")).toBe("#123456");
    // Unsaved values keep their defaults.
    expect(result.current.colors.dynamicRange).toEqual(DEFAULT_CHIP_COLORS.dynamicRange);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the defaults when the layout found nothing saved", () => {
    const { result } = renderHook(() => useChipColors(), { wrapper: wrapperWith(null) });
    expect(result.current.colors).toEqual(DEFAULT_CHIP_COLORS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the colours when the layout could not read them", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ chipColors: { resolution: { "4K": "#abcdef" } } }) });
    const { result } = renderHook(() => useChipColors(), { wrapper: wrapperWith(undefined) });
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/chip-colors");
    await waitFor(() => expect(result.current.getHex("resolution", "4K")).toBe("#abcdef"));
  });
});
