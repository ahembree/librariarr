import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { $queryRawUnsafe: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

import { computeTopPlayedInWindow } from "@/lib/media/top-played-window";

const SINCE = new Date("2026-01-01T00:00:00Z");

/** Answer each statement by what it reads: the play counts, or the representatives. */
function answer(rows: {
  movieTop?: unknown[];
  movieReps?: unknown[];
  seriesTop?: unknown[];
  seriesReps?: unknown[];
  musicTop?: unknown[];
  musicReps?: unknown[];
}) {
  mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string, ...params: unknown[]) => {
    const isTop = sql.includes(`FROM "WatchHistory"`);
    if (sql.includes(`'MOVIE'`)) return (isTop ? rows.movieTop : rows.movieReps) ?? [];
    const type = params[2];
    if (type === "SERIES") return (isTop ? rows.seriesTop : rows.seriesReps) ?? [];
    return (isTop ? rows.musicTop : rows.musicReps) ?? [];
  });
}

const callsMatching = (fragment: string) =>
  mockPrisma.$queryRawUnsafe.mock.calls.filter(([sql]) => (sql as string).includes(fragment));

describe("computeTopPlayedInWindow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
  });

  it("queries nothing without servers", async () => {
    expect(await computeTopPlayedInWindow([], true, SINCE)).toEqual({ topMovies: [], topSeries: [], topMusic: [] });
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("skips the representative lookups when nothing was played", async () => {
    expect(await computeTopPlayedInWindow(["s1"], false, SINCE)).toEqual({ topMovies: [], topSeries: [], topMusic: [] });
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(3);
    for (const [sql, servers, since] of mockPrisma.$queryRawUnsafe.mock.calls) {
      expect(sql).toContain(`FROM "WatchHistory"`);
      expect(sql).toContain(`IS DISTINCT FROM false`);
      expect(servers).toEqual(["s1"]);
      expect(since).toBe(SINCE);
    }
  });

  it("with dedup on, groups films by dedupKey and looks keyed and unkeyed titles up separately", async () => {
    answer({
      movieTop: [
        { title_key: "k1", keyed: true, plays: 5 },
        { title_key: "solo", keyed: false, plays: 3 },
        { title_key: "gone", keyed: false, plays: 1 },
      ],
      movieReps: [
        { title_key: "k1", id: "canon", title: "Shared", year: 2020, thumbUrl: "/t" },
        { title_key: "solo", id: "solo", title: "Alone", year: null, thumbUrl: null },
      ],
    });
    const result = await computeTopPlayedInWindow(["s1", "s2"], true, SINCE);

    const [topSql] = callsMatching(`'MOVIE'`)[0];
    expect(topSql).toContain(`COALESCE(mi."dedupKey", mi.id)`);
    const [repSql, , keys, ids] = callsMatching(`'MOVIE'`)[1];
    // Index-friendly lookup: no filter on the COALESCE expression.
    expect(repSql).toContain(`mi."dedupKey" = ANY($2::text[]) OR mi.id = ANY($3::text[])`);
    expect(repSql).not.toMatch(/COALESCE\(mi\."dedupKey", mi\.id\) = ANY/);
    expect(keys).toEqual(["k1"]);
    expect(ids).toEqual(["solo", "gone"]);

    // A title whose representative is gone is dropped.
    expect(result.topMovies).toEqual([
      { id: "canon", title: "Shared", year: 2020, playCount: 5, thumbUrl: "/t" },
      { id: "solo", title: "Alone", year: null, playCount: 3, thumbUrl: null },
    ]);
  });

  it("with dedup off, ranks each copy on its own", async () => {
    answer({
      movieTop: [{ title_key: "m1", keyed: false, plays: 2 }],
      movieReps: [{ title_key: "m1", id: "m1", title: "One", year: 2001, thumbUrl: null }],
    });
    const result = await computeTopPlayedInWindow(["s1"], false, SINCE);
    const [topSql] = callsMatching(`'MOVIE'`)[0];
    expect(topSql).not.toContain("COALESCE");
    const [, , keys, ids] = callsMatching(`'MOVIE'`)[1];
    expect(keys).toEqual([]);
    expect(ids).toEqual(["m1"]);
    expect(result.topMovies).toEqual([{ id: "m1", title: "One", year: 2001, playCount: 2, thumbUrl: null }]);
  });

  it("groups series by seriesKey and artists by name, keeping a group without a representative", async () => {
    answer({
      seriesTop: [
        { group_key: "tvdb:1", plays: 4 },
        { group_key: "tvdb:2", plays: 2 },
      ],
      seriesReps: [{ group_key: "tvdb:1", id: "ep", parentTitle: "The Office", parentThumbUrl: "/p" }],
      musicTop: [{ group_key: "Artist", plays: 7 }],
      musicReps: [],
    });
    const result = await computeTopPlayedInWindow(["s1"], false, SINCE);

    expect(callsMatching(`mi."seriesKey" AS group_key`).length).toBeGreaterThan(0);
    expect(callsMatching(`mi."parentTitle" AS group_key`).length).toBeGreaterThan(0);
    expect(result.topSeries).toEqual([
      { parentTitle: "The Office", totalPlays: 4, thumbUrl: "/p", mediaItemId: "ep" },
      { parentTitle: "", totalPlays: 2, thumbUrl: null, mediaItemId: null },
    ]);
    // An artist is named by its own key even without a representative row.
    expect(result.topMusic).toEqual([{ parentTitle: "Artist", totalPlays: 7, thumbUrl: null, mediaItemId: null }]);
  });
});
