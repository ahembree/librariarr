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
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

import { fetchCrossSystemData } from "@/lib/conditions/cross-system-data";

describe("fetchCrossSystemData", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no rows in any table so individual tests can override per-call.
    mockPrisma.mediaItem.findMany.mockResolvedValue([]);
    mockPrisma.mediaItem.groupBy.mockResolvedValue([]);
    mockPrisma.ruleMatch.findMany.mockResolvedValue([]);
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([]);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
  });

  it("returns an empty map and queries nothing for empty input", async () => {
    const result = await fetchCrossSystemData([]);
    expect(result.size).toBe(0);
    expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.mediaItem.groupBy).not.toHaveBeenCalled();
    expect(mockPrisma.ruleMatch.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.lifecycleAction.findMany).not.toHaveBeenCalled();
  });

  it("initializes every requested id with defaults when no rows exist", async () => {
    // No dedup keys returned → skips groupBy entirely.
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce([]);

    const result = await fetchCrossSystemData(["a", "b"]);

    expect(result.get("a")).toEqual({
      serverCount: 1,
      matchedRuleSets: [],
      hasPendingAction: false,
    });
    expect(result.get("b")).toEqual({
      serverCount: 1,
      matchedRuleSets: [],
      hasPendingAction: false,
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

  it("counts another server's collapsed copy of a match as matched too", async () => {
    // Detection stores a multi-server title on one copy and lists the others in
    // itemData.copies; the rule set matched "b" as well.
    mockPrisma.ruleMatch.findMany
      .mockResolvedValueOnce([{ mediaItemId: "a", ruleSet: { name: "Leaving Soon" } }])
      .mockResolvedValueOnce([{ copyIds: ["b", "x"], ruleSet: { name: "Leaving Soon" } }]);

    const result = await fetchCrossSystemData(["a", "b"]);

    expect(result.get("a")?.matchedRuleSets).toEqual(["Leaving Soon"]);
    expect(result.get("b")?.matchedRuleSets).toEqual(["Leaving Soon"]);
  });

  it("counts the requested members of a series/artist match, reading each member list whole", async () => {
    // A show match is stored on one representative episode and lists every
    // episode it covers in itemData.memberIds; the query takes no id list
    // (joining a whole library's ids in SQL triggered Postgres JIT).
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { memberIds: ["rep", "b", "unrequested"], name: "Keep" },
      { memberIds: ["b", 42, null], name: "Leaving Soon" },
    ]);

    const result = await fetchCrossSystemData(["b", "c"]);

    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(expect.any(String));
    expect(result.get("b")?.matchedRuleSets).toEqual(["Keep", "Leaving Soon"]);
    expect(result.get("c")?.matchedRuleSets).toEqual([]);
    expect(result.has("unrequested")).toBe(false);
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
      { ruleSetId: "rs", mediaItemId: "a", matchedMediaItemIds: [] },
      { ruleSetId: "rs", mediaItemId: null, matchedMediaItemIds: [] }, // null mediaItemId is skipped
      { ruleSetId: "rs", mediaItemId: "ghost", matchedMediaItemIds: [] }, // not in requested ids
    ]);

    const result = await fetchCrossSystemData(["a", "b"]);

    expect(result.get("a")?.hasPendingAction).toBe(true);
    expect(result.get("b")?.hasPendingAction).toBe(false);
    expect(result.has("ghost")).toBe(false);

    // Every pending action is read whole: none of the requested ids is a bind parameter.
    expect(mockPrisma.lifecycleAction.findMany).toHaveBeenCalledWith({
      where: { status: "PENDING" },
      select: { ruleSetId: true, mediaItemId: true, matchedMediaItemIds: true },
    });
  });

  it("flags the requested members of a pending grouped action", async () => {
    // A show/artist action is stored against one representative and names the
    // episodes/tracks it acts on in matchedMediaItemIds.
    mockPrisma.lifecycleAction.findMany.mockResolvedValueOnce([
      { ruleSetId: "rs", mediaItemId: "rep", matchedMediaItemIds: ["rep", "b", "unrequested"] },
    ]);

    const result = await fetchCrossSystemData(["rep", "b", "c"]);

    expect(result.get("rep")?.hasPendingAction).toBe(true);
    expect(result.get("b")?.hasPendingAction).toBe(true);
    expect(result.get("c")?.hasPendingAction).toBe(false);
    expect(result.has("unrequested")).toBe(false);
  });

  it("leaves the evaluating rule set's own actions out", async () => {
    await fetchCrossSystemData(["a"], { excludeRuleSetId: "own" });

    expect(mockPrisma.lifecycleAction.findMany).toHaveBeenCalledWith({
      where: { status: "PENDING", OR: [{ ruleSetId: null }, { ruleSetId: { not: "own" } }] },
      select: { ruleSetId: true, mediaItemId: true, matchedMediaItemIds: true },
    });
  });

  it("flags the copies a held match lists when its action is pending", async () => {
    mockPrisma.lifecycleAction.findMany.mockResolvedValueOnce([
      { ruleSetId: "rs", mediaItemId: "kept", matchedMediaItemIds: [] },
    ]);
    // ruleMatch.findMany: requested ids, copyIds overlap, then the held matches with copies.
    mockPrisma.ruleMatch.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ruleSetId: "rs", mediaItemId: "kept", copyIds: ["copy"] },
        { ruleSetId: "other", mediaItemId: "kept", copyIds: ["not-pending"] },
      ]);

    const result = await fetchCrossSystemData(["copy", "not-pending"]);

    expect(result.get("copy")?.hasPendingAction).toBe(true);
    expect(result.get("not-pending")?.hasPendingAction).toBe(false);
  });

  it("splits a server-count lookup past the bind-parameter limit", async () => {
    const ids = Array.from({ length: 25_000 }, (_, i) => `id-${i}`);
    mockPrisma.mediaItem.findMany.mockResolvedValueOnce(ids.map((id) => ({ id, dedupKey: `k-${id}` })));

    await fetchCrossSystemData(ids);

    const chunks = mockPrisma.mediaItem.groupBy.mock.calls.map(
      ([args]) => (args as { where: { dedupKey: { in: string[] } } }).where.dedupKey.in.length,
    );
    expect(chunks).toEqual([10_000, 10_000, 5_000]);
  });

  it("combines all three enrichment sources for the same item", async () => {
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
      { ruleSetId: "rs", mediaItemId: "a", matchedMediaItemIds: [] },
    ]);

    const result = await fetchCrossSystemData(["a"]);

    expect(result.get("a")).toEqual({
      serverCount: 2,
      matchedRuleSets: ["Watched"],
      hasPendingAction: true,
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
