import { describe, it, expect, vi, beforeEach } from "vitest";

const { queryRawUnsafe } = vi.hoisted(() => ({ queryRawUnsafe: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { $queryRawUnsafe: queryRawUnsafe } }));

import { loadMissingSummaries } from "@/lib/media/group-summaries";

describe("loadMissingSummaries", () => {
  beforeEach(() => vi.clearAllMocks());

  it("makes no query when nothing is missing", async () => {
    const out = await loadMissingSummaries([], "show");
    expect(out.size).toBe(0);
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("maps each group key to the summary of the episode it named", async () => {
    queryRawUnsafe.mockResolvedValueOnce([
      { id: "ep-1", summary: "Show blurb" },
      { id: "ep-2", summary: null },
    ]);
    const out = await loadMissingSummaries([
      ["tvdb:1", "ep-1"],
      ["tvdb:2", "ep-2"],
      ["tvdb:3", "ep-3"],
    ], "show");
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafe.mock.calls[0][0]).toContain('"parentSummary"');
    expect(queryRawUnsafe.mock.calls[0][1]).toEqual(["ep-1", "ep-2", "ep-3"]);
    expect(out.get("tvdb:1")).toBe("Show blurb");
    expect(out.has("tvdb:2")).toBe(false);
    expect(out.has("tvdb:3")).toBe(false);
  });

  it("reads only the episode's own text for the season listing", async () => {
    queryRawUnsafe.mockResolvedValueOnce([{ id: "ep-1", summary: "Episode blurb" }]);
    const out = await loadMissingSummaries([["tvdb:1::1", "ep-1"]], "episode");
    expect(queryRawUnsafe.mock.calls[0][0]).not.toContain('"parentSummary"');
    expect(out.get("tvdb:1::1")).toBe("Episode blurb");
  });
});
