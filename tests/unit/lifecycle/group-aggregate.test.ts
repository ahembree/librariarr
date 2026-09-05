import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindMany } = vi.hoisted(() => ({ mockFindMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { mediaItem: { findMany: mockFindMany } } }));

import {
  loadGroupMemberStats,
  aggregateGroupMembers,
  memberIdsFromItemData,
  type GroupMemberStats,
} from "@/lib/lifecycle/group-aggregate";

const stats = (entries: Array<[string, Partial<GroupMemberStats>]>) =>
  new Map<string, GroupMemberStats>(
    entries.map(([id, s]) => [
      id,
      { fileSize: BigInt(0), playCount: 0, lastPlayedAt: null, ...s },
    ]),
  );

describe("memberIdsFromItemData", () => {
  it("reads the member ids a match recorded", () => {
    expect(memberIdsFromItemData({ memberIds: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("returns empty for a movie match, a match stored without them, or junk", () => {
    for (const input of [null, undefined, {}, { memberIds: null }, { memberIds: "a" }, 42]) {
      expect(memberIdsFromItemData(input)).toEqual([]);
    }
  });

  it("drops non-string entries rather than passing them to a query", () => {
    expect(memberIdsFromItemData({ memberIds: ["a", 7, null, "b"] })).toEqual(["a", "b"]);
  });
});

describe("aggregateGroupMembers", () => {
  it("sums size and plays and takes the latest play date", () => {
    const result = aggregateGroupMembers(["a", "b", "c"], stats([
      ["a", { fileSize: BigInt(1000), playCount: 2, lastPlayedAt: new Date("2025-01-01") }],
      ["b", { fileSize: BigInt(2000), playCount: 1, lastPlayedAt: new Date("2026-06-01") }],
      ["c", { fileSize: BigInt(500), playCount: 0, lastPlayedAt: null }],
    ]));
    expect(result).toEqual({
      fileSize: BigInt(3500),
      playCount: 3,
      lastPlayedAt: new Date("2026-06-01"),
      matchedEpisodes: 3,
    });
  });

  it("returns null when there is no group, so callers leave the row alone", () => {
    // A movie match, or one stored before member ids were recorded — zeroing
    // its size here would report every movie as 0 bytes.
    expect(aggregateGroupMembers([], stats([]))).toBeNull();
  });

  it("counts every member even when some rows are gone", () => {
    // A member deleted since detection contributes nothing to the totals, but
    // the match still covered it — the count comes from the id list.
    const result = aggregateGroupMembers(["a", "deleted"], stats([
      ["a", { fileSize: BigInt(1000), playCount: 1 }],
    ]));
    expect(result).toEqual({
      fileSize: BigInt(1000),
      playCount: 1,
      lastPlayedAt: null,
      matchedEpisodes: 2,
    });
  });

  it("treats a member with no file as zero bytes rather than skipping it", () => {
    const result = aggregateGroupMembers(["a", "b"], stats([
      ["a", { fileSize: BigInt(0), playCount: 0 }],
      ["b", { fileSize: BigInt(400), playCount: 0 }],
    ]));
    expect(result?.fileSize).toBe(BigInt(400));
    expect(result?.matchedEpisodes).toBe(2);
  });
});

describe("loadGroupMemberStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
  });

  it("issues no query for an empty id list", async () => {
    expect(await loadGroupMemberStats([])).toEqual(new Map());
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("de-duplicates ids so one query covers a whole page of matches", async () => {
    await loadGroupMemberStats(["a", "b", "a", "b", "c"]);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockFindMany.mock.calls[0][0].where.id.in.sort()).toEqual(["a", "b", "c"]);
  });

  it("coalesces a null fileSize to zero so the sum stays a BigInt", async () => {
    mockFindMany.mockResolvedValue([
      { id: "a", fileSize: null, playCount: 3, lastPlayedAt: null },
    ]);
    const result = await loadGroupMemberStats(["a"]);
    expect(result.get("a")).toEqual({ fileSize: BigInt(0), playCount: 3, lastPlayedAt: null });
  });

  it("omits ids with no row rather than failing the request", async () => {
    mockFindMany.mockResolvedValue([
      { id: "a", fileSize: BigInt(10), playCount: 0, lastPlayedAt: null },
    ]);
    const result = await loadGroupMemberStats(["a", "gone"]);
    expect(result.has("a")).toBe(true);
    expect(result.has("gone")).toBe(false);
  });
});
