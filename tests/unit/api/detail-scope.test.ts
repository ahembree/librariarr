import { describe, it, expect, vi, beforeEach } from "vitest";

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { mediaItem: { findFirst } } }));

import { loadDetailScope, seriesOfScope, type DetailScope } from "@/lib/api/detail-scope";

const scope = (overrides: Partial<DetailScope>): DetailScope => ({
  title: "Pilot",
  parentTitle: "The Show",
  seriesKey: "tvdb:1",
  seasonNumber: 1,
  albumTitle: null,
  ...overrides,
});

describe("loadDetailScope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads only an item of the list's type on the user's own servers", async () => {
    findFirst.mockResolvedValueOnce(scope({}));
    expect(await loadDetailScope("user-1", "item-1", "SERIES")).toEqual(scope({}));
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "item-1", type: "SERIES", library: { mediaServer: { userId: "user-1" } } },
      select: { title: true, parentTitle: true, seriesKey: true, seasonNumber: true, albumTitle: true },
    });
  });

  it("answers null for an item it cannot read", async () => {
    findFirst.mockResolvedValueOnce(null);
    expect(await loadDetailScope("user-1", "missing", "MUSIC")).toBeNull();
  });
});

describe("seriesOfScope", () => {
  it("names a show by its series key", () => {
    expect(seriesOfScope(scope({}))).toEqual({ seriesKey: "tvdb:1" });
  });

  it("falls back to the show title, then the row's own, for a row with no key", () => {
    expect(seriesOfScope(scope({ seriesKey: null }))).toEqual({ parentTitle: "The Show" });
    expect(seriesOfScope(scope({ seriesKey: null, parentTitle: null }))).toEqual({ parentTitle: "Pilot" });
  });
});
