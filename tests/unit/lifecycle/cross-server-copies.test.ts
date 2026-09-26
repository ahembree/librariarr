import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  mediaItemExternalId: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

import {
  arrIdSourceFor,
  copyIdsOf,
  copyRank,
  crossServerCopyKeys,
} from "@/lib/lifecycle/cross-server-copies";
import type { ArrDataMap } from "@/lib/rules/lifecycle-engine";

const withIds = (id: string, source: string, externalId: string) => ({
  id,
  externalIds: [{ source, externalId }],
});

describe("arrIdSourceFor", () => {
  it("maps each library type to the id its Arr family resolves by", () => {
    expect(arrIdSourceFor("MOVIE")).toBe("TMDB");
    expect(arrIdSourceFor("SERIES")).toBe("TVDB");
    expect(arrIdSourceFor("MUSIC")).toBe("MUSICBRAINZ");
  });
});

describe("crossServerCopyKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.mediaItemExternalId.findMany.mockResolvedValue([]);
  });

  it("collapses nothing on a single-server rule set", async () => {
    const keys = await crossServerCopyKeys([withIds("a", "TMDB", "1"), withIds("b", "TMDB", "1")], {
      type: "MOVIE",
      serverCount: 1,
      actionArmed: true,
    });
    expect(keys.size).toBe(0);
  });

  it("collapses nothing without Arr data when no action is armed", async () => {
    const keys = await crossServerCopyKeys([withIds("a", "TMDB", "1")], {
      type: "MOVIE",
      serverCount: 2,
      actionArmed: false,
    });
    expect(keys.size).toBe(0);
    expect(mockPrisma.mediaItemExternalId.findMany).not.toHaveBeenCalled();
  });

  it("with Arr data, keys only items that resolved to an Arr record", async () => {
    const arrData = { "1": {} } as unknown as ArrDataMap;
    const keys = await crossServerCopyKeys(
      [withIds("a", "TMDB", "1"), withIds("b", "TMDB", "2"), withIds("c", "TVDB", "1")],
      { type: "MOVIE", serverCount: 2, arrData, actionArmed: false },
    );
    expect([...keys]).toEqual([["a", "1"]]);
    expect(mockPrisma.mediaItemExternalId.findMany).not.toHaveBeenCalled();
  });

  it("without Arr data and an armed action, loads ids the engine did not return", async () => {
    mockPrisma.mediaItemExternalId.findMany.mockResolvedValue([
      { mediaItemId: "b", externalId: "77" },
    ]);
    const keys = await crossServerCopyKeys(
      [withIds("a", "TVDB", "77"), { id: "b" }, { id: "c" }],
      { type: "SERIES", serverCount: 3, actionArmed: true },
    );
    expect(mockPrisma.mediaItemExternalId.findMany).toHaveBeenCalledWith({
      where: { mediaItemId: { in: ["b", "c"] }, source: "TVDB" },
      select: { mediaItemId: true, externalId: true },
    });
    expect(keys.get("a")).toBe("77");
    expect(keys.get("b")).toBe("77");
    expect(keys.has("c")).toBe(false);
  });

  it("does not query when every item already carries its external ids", async () => {
    await crossServerCopyKeys([withIds("a", "TMDB", "1"), { id: "b", externalIds: [] }], {
      type: "MOVIE",
      serverCount: 2,
      actionArmed: true,
    });
    expect(mockPrisma.mediaItemExternalId.findMany).not.toHaveBeenCalled();
  });
});

describe("copyIdsOf", () => {
  it("returns the string ids listed under copies", () => {
    expect(copyIdsOf({ copies: [{ id: "b" }, { id: 3 }, null, { id: "c" }] })).toEqual(["b", "c"]);
  });

  it("returns [] when there are no copies", () => {
    expect(copyIdsOf(null)).toEqual([]);
    expect(copyIdsOf(undefined)).toEqual([]);
    expect(copyIdsOf({})).toEqual([]);
    expect(copyIdsOf({ copies: "nope" })).toEqual([]);
  });
});

describe("copyRank", () => {
  it("ranks a held id, then a copy a held match lists, then any other copy", () => {
    const held = new Set(["a"]);
    const listed = new Map([["b", "a"]]);
    expect(copyRank("a", held, listed)).toBe(0);
    expect(copyRank("b", held, listed)).toBe(1);
    expect(copyRank("c", held, listed)).toBe(2);
  });
});
