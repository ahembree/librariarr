import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    mediaItem: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    ruleMatch: {
      findMany: vi.fn(),
    },
    lifecycleAction: {
      findMany: vi.fn(),
    },
    lifecycleException: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

import { fetchCrossSystemData } from "@/lib/conditions/cross-system-data";

describe("fetchCrossSystemData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no rows in any table so individual tests can override per-call.
    mockPrisma.mediaItem.findMany.mockResolvedValue([]);
    mockPrisma.mediaItem.groupBy.mockResolvedValue([]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
  });

  it("returns an empty map and queries nothing for empty input", async () => {
    const result = await fetchCrossSystemData([]);
    expect(result.size).toBe(0);
    expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.mediaItem.groupBy).not.toHaveBeenCalled();
    expect(mockPrisma.ruleMatch.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.lifecycleAction.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.lifecycleException.findMany).not.toHaveBeenCalled();
  });

  it("initializes every requested id with defaults when no rows exist", async () => {
    // No dedup keys returned → skips groupBy entirely.
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([]);

    const result = await fetchCrossSystemData(["a", "b"]);

    expect(result.get("a")).toEqual({
      serverCount: 1,
      matchedRuleSets: [],
      hasPendingAction: false,
      excludedInLibrariarr: false,
    });
    expect(result.get("b")).toEqual({
      serverCount: 1,
      matchedRuleSets: [],
      hasPendingAction: false,
      excludedInLibrariarr: false,
    });
    // No dedup keys → no groupBy call.
    expect(mockPrisma.mediaItem.groupBy).not.toHaveBeenCalled();
  });

  it("computes serverCount from dedupKey groupBy counts", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([
      { id: "a", dedupKey: "k1" },
      { id: "b", dedupKey: "k1" },
      { id: "c", dedupKey: "k2" },
    ]);
    mockPrisma.mediaItem.groupBy.mockResolvedValueOnce([
      { dedupKey: "k1", _count: { id: 3 } },
      { dedupKey: "k2", _count: { id: 1 } },
    ]);

    const result = await fetchCrossSystemData(["a", "b", "c"]);

    expect(result.get("a")?.serverCount).toBe(3);
    expect(result.get("b")?.serverCount).toBe(3);
    expect(result.get("c")?.serverCount).toBe(1);

    // dedupKey query is deduplicated to unique keys.
    expect(mockPrisma.mediaItem.groupBy).toHaveBeenCalledWith({
      by: ["dedupKey"],
      where: { dedupKey: { in: ["k1", "k2"] } },
      _count: { id: true },
    });
  });

  it("defaults serverCount to 1 when a dedupKey has no count row", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([
      { id: "a", dedupKey: "k1" },
    ]);
    // groupBy returns nothing for k1 → fall back to 1.
    mockPrisma.mediaItem.groupBy.mockResolvedValueOnce([]);

    const result = await fetchCrossSystemData(["a"]);
    expect(result.get("a")?.serverCount).toBe(1);
  });

  it("ignores null dedupKeys when building the unique-key list", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([
      { id: "a", dedupKey: null },
      { id: "b", dedupKey: "k1" },
    ]);
    mockPrisma.mediaItem.groupBy.mockResolvedValueOnce([
      { dedupKey: "k1", _count: { id: 2 } },
    ]);

    const result = await fetchCrossSystemData(["a", "b"]);

    // Item with null dedupKey keeps default serverCount 1.
    expect(result.get("a")?.serverCount).toBe(1);
    expect(result.get("b")?.serverCount).toBe(2);
    expect(mockPrisma.mediaItem.groupBy).toHaveBeenCalledWith({
      by: ["dedupKey"],
      where: { dedupKey: { in: ["k1"] } },
      _count: { id: true },
    });
  });

  it("collects unique matched rule set names per item", async () => {
    mockPrisma.ruleMatch.findMany.mockResolvedValueOnce([
      { mediaItemId: "a", ruleSet: { name: "Stale Movies" } },
      { mediaItemId: "a", ruleSet: { name: "Stale Movies" } }, // duplicate
      { mediaItemId: "a", ruleSet: { name: "Big Files" } },
      { mediaItemId: "b", ruleSet: { name: "Big Files" } },
    ]);

    const result = await fetchCrossSystemData(["a", "b"]);

    expect(result.get("a")?.matchedRuleSets).toEqual(["Stale Movies", "Big Files"]);
    expect(result.get("b")?.matchedRuleSets).toEqual(["Big Files"]);
  });

  it("skips rule matches with empty rule set names", async () => {
    mockPrisma.ruleMatch.findMany.mockResolvedValueOnce([
      { mediaItemId: "a", ruleSet: { name: "" } },
    ]);

    const result = await fetchCrossSystemData(["a"]);
    expect(result.get("a")?.matchedRuleSets).toEqual([]);
  });

  it("ignores rule matches whose item is not in the requested set", async () => {
    mockPrisma.ruleMatch.findMany.mockResolvedValueOnce([
      { mediaItemId: "ghost", ruleSet: { name: "Orphan" } },
    ]);

    const result = await fetchCrossSystemData(["a"]);
    expect(result.get("a")?.matchedRuleSets).toEqual([]);
  });

  it("flags items with a pending lifecycle action", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValueOnce([
      { mediaItemId: "a" },
      { mediaItemId: null }, // null mediaItemId is skipped
      { mediaItemId: "ghost" }, // not in requested ids
    ]);

    const result = await fetchCrossSystemData(["a", "b"]);

    expect(result.get("a")?.hasPendingAction).toBe(true);
    expect(result.get("b")?.hasPendingAction).toBe(false);

    expect(mockPrisma.lifecycleAction.findMany).toHaveBeenCalledWith({
      where: { mediaItemId: { in: ["a", "b"], not: null }, status: "PENDING" },
      select: { mediaItemId: true },
      distinct: ["mediaItemId"],
    });
  });

  it("flags items with a lifecycle exception", async () => {
    mockPrisma.lifecycleException.findMany.mockResolvedValueOnce([
      { mediaItemId: "a" },
      { mediaItemId: "ghost" }, // not in requested ids
    ]);

    const result = await fetchCrossSystemData(["a", "b"]);

    expect(result.get("a")?.excludedInLibrariarr).toBe(true);
    expect(result.get("b")?.excludedInLibrariarr).toBe(false);

    expect(mockPrisma.lifecycleException.findMany).toHaveBeenCalledWith({
      where: { mediaItemId: { in: ["a", "b"] } },
      select: { mediaItemId: true },
      distinct: ["mediaItemId"],
    });
  });

  it("combines all enrichment sources for the same item", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([
      { id: "a", dedupKey: "k1" },
    ]);
    mockPrisma.mediaItem.groupBy.mockResolvedValueOnce([
      { dedupKey: "k1", _count: { id: 2 } },
    ]);
    mockPrisma.ruleMatch.findMany.mockResolvedValueOnce([
      { mediaItemId: "a", ruleSet: { name: "Watched" } },
    ]);
    mockPrisma.lifecycleAction.findMany.mockResolvedValueOnce([
      { mediaItemId: "a" },
    ]);
    mockPrisma.lifecycleException.findMany.mockResolvedValueOnce([
      { mediaItemId: "a" },
    ]);

    const result = await fetchCrossSystemData(["a"]);

    expect(result.get("a")).toEqual({
      serverCount: 2,
      matchedRuleSets: ["Watched"],
      hasPendingAction: true,
      excludedInLibrariarr: true,
    });
  });

  it("queries media items, rule matches scoped to the requested ids", async () => {
    await fetchCrossSystemData(["a", "b"]);

    expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b"] } },
      select: { id: true, dedupKey: true },
    });
    expect(mockPrisma.ruleMatch.findMany).toHaveBeenCalledWith({
      where: { mediaItemId: { in: ["a", "b"] } },
      select: { mediaItemId: true, ruleSet: { select: { name: true } } },
    });
  });
});
