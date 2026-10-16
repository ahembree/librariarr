import { describe, it, expect, vi, beforeEach } from "vitest";

const { queryRaw, getOrSet } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  getOrSet: vi.fn(async (_key: string, compute: () => Promise<unknown>) => compute()),
}));

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: queryRaw } }));
vi.mock("@/lib/cache/memory-cache", () => ({ appCache: { getOrSet } }));

import { loadResolutionSpellings } from "@/lib/filters/resolution-spellings";

describe("loadResolutionSpellings", () => {
  beforeEach(() => {
    queryRaw.mockReset();
    getOrSet.mockClear();
  });

  it("makes no lookup when the request has no resolution filter", async () => {
    expect(await loadResolutionSpellings(new URLSearchParams({ genre: "Drama" }))).toBeUndefined();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  // The labels the quality chips and the filter dropdown show, so a PAL "576"
  // is found under 480P rather than under Other.
  it("groups the stored values by the label normalizeResolutionLabel gives them", async () => {
    queryRaw.mockResolvedValue(
      ["4k", "2160", "1080", "1024", "576", "480p", "sd", "", "weird"].map((resolution) => ({ resolution })),
    );
    const spellings = await loadResolutionSpellings(new URLSearchParams({ resolution: "480P" }));
    expect(Object.fromEntries(spellings!)).toEqual({
      "4K": ["4k", "2160"],
      "1080P": ["1080", "1024"],
      "480P": ["576", "480p"],
      SD: ["sd"],
      Other: ["", "weird"],
    });
  });

  it("caches the stored values under the distinct-values prefix invalidateMediaCaches drops", async () => {
    queryRaw.mockResolvedValue([]);
    await loadResolutionSpellings(new URLSearchParams({ resolution: "4K" }));
    expect(getOrSet).toHaveBeenCalledWith("distinct-values:resolutions", expect.any(Function), expect.any(Number));
  });
});
