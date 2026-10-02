import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  mediaItem: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

import { countShowEpisodes, loadLocalShows } from "@/lib/seerr/library-match";

function episode(
  id: string,
  seriesKey: string | null,
  ids: Array<[string, string]>,
  extra: { dedupKey?: string | null; parentTitle?: string | null } = {},
) {
  return {
    id,
    dedupKey: extra.dedupKey ?? null,
    parentTitle: extra.parentTitle === undefined ? "Show" : extra.parentTitle,
    seriesKey,
    externalIds: ids.map(([source, externalId]) => ({ source, externalId })),
  };
}

describe("loadLocalShows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.mediaItem.findMany.mockResolvedValue([]);
  });

  it("skips the query when there are no servers or no ids to match", async () => {
    const noServers = await loadLocalShows([], [{ tvdbId: 1, tmdbId: 2 }]);
    expect(noServers.shows.size).toBe(0);
    const noIds = await loadLocalShows(["s1"], [{ tvdbId: null, tmdbId: undefined }]);
    expect(noIds.shows.size).toBe(0);
    expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
  });

  it("queries canonical episodes on the given servers by TVDB or TMDB id", async () => {
    await loadLocalShows(["s1", "s2"], [
      { tvdbId: 100, tmdbId: null },
      { tvdbId: null, tmdbId: 200 },
      { tvdbId: 100, tmdbId: 300 },
    ]);
    const where = mockPrisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.type).toBe("SERIES");
    expect(where.dedupCanonical).toBe(true);
    expect(where.episodeNumber).toEqual({ not: null });
    expect(where.library).toEqual({ mediaServerId: { in: ["s1", "s2"] } });
    expect(where.externalIds.some.OR).toEqual([
      { source: "TVDB", externalId: { in: ["100"] } },
      { source: "TMDB", externalId: { in: ["200", "300"] } },
    ]);
  });

  it("omits the TVDB filter when no request carries a TVDB id", async () => {
    await loadLocalShows(["s1"], [{ tvdbId: null, tmdbId: 200 }]);
    const where = mockPrisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.externalIds.some.OR).toEqual([{ source: "TMDB", externalId: { in: ["200"] } }]);
  });

  it("groups episodes by seriesKey and resolves a request by TVDB, then TMDB", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      episode("e1", "tvdb:100", [["TVDB", "100"], ["TMDB", "500"]], { parentTitle: "The Office" }),
      episode("e2", "tvdb:100", [["TVDB", "100"], ["TMDB", "500"]], { parentTitle: "The Office" }),
      // A Jellyfin library with no TVDB provider: TMDB only.
      episode("e3", "tmdb:200", [["TMDB", "200"]], { parentTitle: "Jelly Show" }),
    ]);

    const index = await loadLocalShows(["s1"], [
      { tvdbId: 100, tmdbId: 500 },
      { tvdbId: null, tmdbId: 200 },
    ]);

    expect(index.shows.size).toBe(2);
    const office = index.shows.get("tvdb:100")!;
    expect(office.title).toBe("The Office");
    expect(office.representativeEpisodeId).toBe("e1");
    expect(office.episodes.map((e) => e.id)).toEqual(["e1", "e2"]);

    expect(index.resolve({ tvdbId: 100, tmdbId: null })).toBe(office);
    // TMDB alone reaches the same show.
    expect(index.resolve({ tvdbId: null, tmdbId: 500 })).toBe(office);
    // A TVDB id the library lacks falls through to the TMDB id.
    expect(index.resolve({ tvdbId: 999, tmdbId: 200 })?.seriesKey).toBe("tmdb:200");
    expect(index.resolve({ tvdbId: 999, tmdbId: 998 })).toBeUndefined();
    expect(index.resolve({ tvdbId: null, tmdbId: null })).toBeUndefined();
  });

  it("prefers the TVDB match when TVDB and TMDB point at different shows", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      episode("a1", "tvdb:1", [["TVDB", "1"]]),
      episode("b1", "tmdb:2", [["TMDB", "2"]]),
    ]);
    const index = await loadLocalShows(["s1"], [{ tvdbId: 1, tmdbId: 2 }]);
    expect(index.resolve({ tvdbId: 1, tmdbId: 2 })?.seriesKey).toBe("tvdb:1");
  });

  it("keeps two same-titled shows with different ids apart", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      episode("uk1", "tvdb:78107", [["TVDB", "78107"]], { parentTitle: "The Office" }),
      episode("us1", "tvdb:73244", [["TVDB", "73244"]], { parentTitle: "The Office" }),
    ]);
    const index = await loadLocalShows(["s1"], [
      { tvdbId: 78107, tmdbId: null },
      { tvdbId: 73244, tmdbId: null },
    ]);
    expect(index.shows.size).toBe(2);
    expect(index.resolve({ tvdbId: 78107, tmdbId: null })?.representativeEpisodeId).toBe("uk1");
    expect(index.resolve({ tvdbId: 73244, tmdbId: null })?.representativeEpisodeId).toBe("us1");
  });

  it("derives the key for a legacy row without a stored seriesKey", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      episode("e1", null, [["TVDB", "42"]]),
    ]);
    const index = await loadLocalShows(["s1"], [{ tvdbId: 42, tmdbId: null }]);
    expect(index.resolve({ tvdbId: 42, tmdbId: null })?.seriesKey).toBe("tvdb:42");
  });

  it("takes the title from a later episode when the first has none", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      episode("e1", "tvdb:7", [["TVDB", "7"]], { parentTitle: null }),
      episode("e2", "tvdb:7", [["TVDB", "7"]], { parentTitle: "Named" }),
    ]);
    const index = await loadLocalShows(["s1"], [{ tvdbId: 7, tmdbId: null }]);
    expect(index.shows.get("tvdb:7")?.title).toBe("Named");
  });
});

describe("countShowEpisodes", () => {
  it("counts distinct dedupKeys when the rows carry them", () => {
    expect(
      countShowEpisodes({
        seriesKey: "tvdb:1",
        title: "Show",
        representativeEpisodeId: "e1",
        episodes: [
          { id: "e1", dedupKey: "k1" },
          { id: "e2", dedupKey: "k1" },
          { id: "e3", dedupKey: "k2" },
        ],
      }),
    ).toBe(2);
  });

  it("falls back to the row count when no row carries a dedupKey", () => {
    expect(
      countShowEpisodes({
        seriesKey: "tvdb:1",
        title: "Show",
        representativeEpisodeId: "e1",
        episodes: [
          { id: "e1", dedupKey: null },
          { id: "e2", dedupKey: null },
        ],
      }),
    ).toBe(2);
  });
});
