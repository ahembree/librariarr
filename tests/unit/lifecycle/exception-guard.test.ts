import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  lifecycleException: { findMany: vi.fn() },
  $queryRawUnsafe: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

import {
  findExceptedItemIds,
  findExceptionProtectedGroups,
  hasProtectionGroup,
  protectionKeys,
  isGroupProtected,
  protectionKey,
  isWholeRecordDestructiveAction,
  type ProtectionTarget,
} from "@/lib/lifecycle/exception-guard";

describe("isWholeRecordDestructiveAction", () => {
  it("is true for whole-record deletes", () => {
    expect(isWholeRecordDestructiveAction("DELETE_SONARR")).toBe(true);
    expect(isWholeRecordDestructiveAction("DELETE_LIDARR")).toBe(true);
    expect(isWholeRecordDestructiveAction("DELETE_RADARR")).toBe(true);
  });

  it("is false for member-scoped deletes (they honor the member list)", () => {
    expect(isWholeRecordDestructiveAction("DELETE_FILES_SONARR")).toBe(false);
    expect(isWholeRecordDestructiveAction("UNMONITOR_DELETE_FILES_SONARR")).toBe(false);
    expect(isWholeRecordDestructiveAction("MONITOR_DELETE_FILES_LIDARR")).toBe(false);
  });

  it("is false for non-destructive actions", () => {
    expect(isWholeRecordDestructiveAction("UNMONITOR_SONARR")).toBe(false);
    expect(isWholeRecordDestructiveAction("CHANGE_QUALITY_PROFILE_RADARR")).toBe(false);
    expect(isWholeRecordDestructiveAction("SEARCH_SONARR")).toBe(false);
    expect(isWholeRecordDestructiveAction("DO_NOTHING")).toBe(false);
  });
});

describe("protectionKey", () => {
  it("keys a series on seriesKey, not its title", () => {
    // The whole point. A DELETE_SONARR removes the Sonarr series, so the guard
    // has to recognise the same show under whatever title each server gave it.
    // The US show (TVDB 73244), titled differently on each of two servers.
    const serverA = protectionKey({ parentTitle: "The Office", seriesKey: "tvdb:73244", type: "SERIES" });
    const serverB = protectionKey({ parentTitle: "The Office (US)", seriesKey: "tvdb:73244", type: "SERIES" });
    expect(serverA).toBe("SERIES:tvdb:73244");
    expect(serverB).toBe("SERIES:tvdb:73244");
  });

  it("separates two different shows that share a title", () => {
    // The US (73244) and UK (78107) shows.
    expect(protectionKey({ parentTitle: "The Office", seriesKey: "tvdb:73244", type: "SERIES" })).toBe("SERIES:tvdb:73244");
    expect(protectionKey({ parentTitle: "The Office", seriesKey: "tvdb:78107", type: "SERIES" })).toBe("SERIES:tvdb:78107");
  });

  it("falls back to the same title key a keyless row would compute", () => {
    // `seriesKeyFromTitle`, so a row that predates the `seriesKey` column still
    // collides with a backfilled one whose key came from the same title.
    expect(protectionKey({ parentTitle: " The Show ", seriesKey: null, type: "SERIES" })).toBe("SERIES:title:the show");
    expect(protectionKey({ parentTitle: "the show", seriesKey: "title:the show", type: "SERIES" })).toBe(
      "SERIES:title:the show",
    );
  });

  it("keys music on the artist title (`protectionKeys` adds the MusicBrainz id)", () => {
    expect(protectionKey({ parentTitle: "Boards of Canada", type: "MUSIC" })).toBe("MUSIC:title:boards of canada");
    expect(protectionKey({ parentTitle: "boards of canada", type: "MUSIC" })).toBe("MUSIC:title:boards of canada");
  });

  it("namespaces by type so a same-named show and artist never cross", () => {
    expect(protectionKey({ parentTitle: "Ghost", seriesKey: "title:ghost", type: "SERIES" })).not.toBe(
      protectionKey({ parentTitle: "Ghost", type: "MUSIC" }),
    );
  });

  it("is null for a movie — its own exception row is checked directly", () => {
    expect(protectionKey({ parentTitle: null, type: "MOVIE" })).toBeNull();
  });
});

describe("findExceptedItemIds — a library's worth of candidates", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // A track-scope music rule set matching 38k tracks sent them as one IN list
  // beside the owner filter, past Postgres' 32,767 bind parameters (P2029),
  // and Re-evaluate All answered 500.
  it("sends the candidates as one array parameter, however many there are", async () => {
    const candidates = Array.from({ length: 40_000 }, (_, i) => `t${i}`);
    mockPrisma.lifecycleException.findMany.mockResolvedValue([
      { mediaItemId: "t5", mediaItem: { dedupKey: "track:a" } },
      { mediaItemId: "elsewhere", mediaItem: { dedupKey: "track:b" } },
    ]);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      { id: "t7", dedupKey: "track:b" },
      { id: "t9", dedupKey: "track:other" },
    ]);

    const excepted = await findExceptedItemIds("u1", candidates);

    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ids, userId] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain(`mi."id" = ANY($1::text[])`);
    expect(sql).toContain(`ms."userId" = $2`);
    expect(ids).toHaveLength(40_000);
    expect(userId).toBe("u1");
    // Its own exception, and a copy of another excepted item.
    expect(excepted).toEqual(new Set(["t5", "t7"]));
  });

  it("does not look the candidates up when no exception carries a dedupKey", async () => {
    mockPrisma.lifecycleException.findMany.mockResolvedValue([{ mediaItemId: "a", mediaItem: { dedupKey: null } }]);
    expect(await findExceptedItemIds("u1", ["a", "b"])).toEqual(new Set(["a"]));
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("asks nothing for no candidates", async () => {
    expect(await findExceptedItemIds("u1", [])).toEqual(new Set());
    expect(mockPrisma.lifecycleException.findMany).not.toHaveBeenCalled();
  });
});

describe("findExceptionProtectedGroups — slices", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("splits a library's worth of titles and ids into statements under the parameter limit, and unions the keys", async () => {
    const targets: ProtectionTarget[] = Array.from({ length: 20_000 }, (_, i) => ({
      parentTitle: `Artist ${i}`,
      type: "MUSIC",
      externalIds: [{ source: "MUSICBRAINZ", externalId: `mbid-${i}` }],
    }));
    mockPrisma.lifecycleException.findMany
      .mockResolvedValueOnce([{ mediaItem: { parentTitle: "Artist 3", seriesKey: null, type: "MUSIC", externalIds: [] } }])
      .mockResolvedValue([]);

    const keys = await findExceptionProtectedGroups("u1", targets);

    const calls = mockPrisma.lifecycleException.findMany.mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    let titles = 0;
    for (const [args] of calls) {
      const or = args.where.mediaItem.OR as Array<Record<string, { in?: string[] } & Record<string, unknown>>>;
      const parentList = (or.find((c) => "parentTitle" in c)?.parentTitle as { in: string[] }).in;
      const mbidList = (
        (or.find((c) => "externalIds" in c)?.externalIds as { some: { externalId: { in: string[] } } }).some.externalId
      ).in;
      // Well under 32,767 bind parameters per statement.
      expect(parentList.length + mbidList.length).toBeLessThanOrEqual(15_000);
      titles += parentList.length;
    }
    expect(titles).toBe(20_000);
    expect(isGroupProtected(keys, { parentTitle: "artist 3", type: "MUSIC" })).toBe(true);
  });
});

describe("findExceptionProtectedGroups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty set without querying when nothing has a group (movies)", async () => {
    const result = await findExceptionProtectedGroups("u1", [
      { parentTitle: null, type: "MOVIE" },
    ]);
    expect(result.size).toBe(0);
    expect(mockPrisma.lifecycleException.findMany).not.toHaveBeenCalled();
  });

  it("protects a show whose exception was filed under another server's title", async () => {
    // The bug this keys on `seriesKey` to fix: two servers, two titles, one
    // TVDB id. Keyed on `parentTitle` the exception did not match the action's
    // copy, and the whole-series delete went ahead.
    mockPrisma.lifecycleException.findMany.mockResolvedValue([
      { mediaItem: { parentTitle: "The Office (US)", seriesKey: "tvdb:73244", type: "SERIES" } },
    ]);

    const result = await findExceptionProtectedGroups("u1", [
      { parentTitle: "The Office", seriesKey: "tvdb:73244", type: "SERIES" },
    ]);

    expect(result).toEqual(new Set(["SERIES:tvdb:73244"]));
  });

  it("does not let a same-titled DIFFERENT show block one", async () => {
    // The other direction, which the title key got wrong too: an exception on
    // the 1978 Battlestar must not stop a delete of the 2004 one. The lookup
    // matches it by title, but it comes back under its OWN key.
    mockPrisma.lifecycleException.findMany.mockResolvedValue([
      { mediaItem: { parentTitle: "Battlestar Galactica", seriesKey: "tvdb:71173", type: "SERIES" } },
    ]);
    const target = { parentTitle: "Battlestar Galactica", seriesKey: "tvdb:73545", type: "SERIES" };

    const result = await findExceptionProtectedGroups("u1", [target]);

    expect(result.has(protectionKey(target)!)).toBe(false);
    expect(result).toEqual(new Set(["SERIES:tvdb:71173"]));
  });

  it("searches both columns so a keyless legacy exception still matches", async () => {
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);

    await findExceptionProtectedGroups("u1", [
      { parentTitle: "Protected Show", seriesKey: "tvdb:1", type: "SERIES" },
    ]);

    expect(mockPrisma.lifecycleException.findMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        mediaItem: {
          OR: [
            { parentTitle: { in: ["Protected Show"], mode: "insensitive" } },
            { seriesKey: { in: ["tvdb:1"] } },
          ],
          type: { in: ["SERIES"] },
        },
      },
      select: {
        mediaItem: {
          select: {
            parentTitle: true,
            seriesKey: true,
            type: true,
            externalIds: { where: { source: "MUSICBRAINZ" }, select: { source: true, externalId: true } },
          },
        },
      },
    });
  });

  it("scopes the exception lookup to the items' media types", async () => {
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);

    await findExceptionProtectedGroups("u1", [
      { parentTitle: "Some Artist", type: "MUSIC" },
    ]);

    expect(mockPrisma.lifecycleException.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          mediaItem: expect.objectContaining({ type: { in: ["MUSIC"] } }),
        }),
      }),
    );
  });

  it("returns an empty set when no exceptions exist for the groups", async () => {
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    const result = await findExceptionProtectedGroups("u1", [
      { parentTitle: "Show", seriesKey: "tvdb:9", type: "SERIES" },
    ]);
    expect(result.size).toBe(0);
  });
});

describe("isGroupProtected — artists", () => {
  // Two different artists named "Nirvana": the Seattle band and the 1960s UK
  // one, with their MusicBrainz artist ids.
  const SEATTLE = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
  const UK = "9282c8b4-ca0b-4c6b-b7e3-4f7762dfc4d6";
  const track = (parentTitle: string | null, mbid?: string): ProtectionTarget => ({
    parentTitle,
    type: "MUSIC",
    externalIds: mbid ? [{ source: "MUSICBRAINZ", externalId: mbid }] : [],
  });
  const protectedBy = (exceptions: ProtectionTarget[], target: ProtectionTarget) =>
    isGroupProtected(new Set<string>(exceptions.flatMap(protectionKeys)), target);

  it("protects on the same title even when the ids differ — never under-blocks", () => {
    // Two ids under one name may be two artists or one artist under a merged
    // id Lidarr resolves to the same record; only the first is safe to delete.
    expect(protectedBy([track("Nirvana", UK)], track("Nirvana", SEATTLE))).toBe(true);
  });

  it("protects the same artist, whatever the title's case or spacing", () => {
    expect(protectedBy([track(" nirvana ", SEATTLE)], track("Nirvana", SEATTLE))).toBe(true);
  });

  it("protects the same artist spelled differently on another server", () => {
    // Lidarr deletes the artist by id, so the id is the identity.
    expect(protectedBy([track("Beyonce", "mbid-b")], track("Beyoncé", "mbid-b"))).toBe(true);
  });

  it("protects on the title when either side has no id", () => {
    expect(protectedBy([track("Nirvana")], track("Nirvana", SEATTLE))).toBe(true);
    expect(protectedBy([track("Nirvana", UK)], track("Nirvana"))).toBe(true);
    expect(protectedBy([track("Nirvana")], track("Nirvana"))).toBe(true);
  });

  it("is false for another title with no shared id", () => {
    expect(protectedBy([track("Bush", "mbid-bush")], track("Nirvana", SEATTLE))).toBe(false);
    expect(protectedBy([track("Bush")], track("Nirvana"))).toBe(false);
  });

  it("guards a track with an id but no artist title", () => {
    const untitled = track(null, SEATTLE);
    expect(hasProtectionGroup(untitled)).toBe(true);
    expect(protectedBy([track("Nirvana", SEATTLE)], untitled)).toBe(true);
    expect(hasProtectionGroup(track(null))).toBe(false);
  });

  it("looks exceptions up by the targets' artist ids as well as their titles, titles case-insensitively", async () => {
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    await findExceptionProtectedGroups("u1", [track("Beyoncé", "mbid-b")]);
    expect(mockPrisma.lifecycleException.findMany.mock.lastCall![0].where.mediaItem.OR).toEqual([
      { parentTitle: { in: ["Beyoncé"], mode: "insensitive" } },
      { type: "MUSIC", externalIds: { some: { source: "MUSICBRAINZ", externalId: { in: ["mbid-b"] } } } },
    ]);
  });

  it("finds an exception filed on the artist under another spelling by its id", async () => {
    mockPrisma.lifecycleException.findMany.mockResolvedValue([
      { mediaItem: { parentTitle: "Beyonce", seriesKey: null, type: "MUSIC", externalIds: [{ source: "MUSICBRAINZ", externalId: "mbid-b" }] } },
    ]);
    const target = track("Beyoncé", "mbid-b");
    expect(isGroupProtected(await findExceptionProtectedGroups("u1", [target]), target)).toBe(true);
  });
});

describe("isGroupProtected — series and movies", () => {
  it("matches a series on its protection key", () => {
    const set = new Set(protectionKeys({ parentTitle: "The Office (US)", seriesKey: "tvdb:73244", type: "SERIES" }));
    expect(isGroupProtected(set, { parentTitle: "The Office", seriesKey: "tvdb:73244", type: "SERIES" })).toBe(true);
    expect(isGroupProtected(set, { parentTitle: "The Office", seriesKey: "tvdb:78107", type: "SERIES" })).toBe(false);
  });

  it("is false for an item with no group", () => {
    expect(isGroupProtected(new Set(["MOVIE:title:x"]), { parentTitle: null, type: "MOVIE" })).toBe(false);
  });
});
