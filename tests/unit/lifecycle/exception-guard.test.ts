import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  lifecycleException: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

import {
  findExceptionProtectedGroups,
  protectionKey,
  isWholeRecordDestructiveAction,
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
    const uk = protectionKey({ parentTitle: "The Office", seriesKey: "tvdb:73244", type: "SERIES" });
    const us = protectionKey({ parentTitle: "The Office (US)", seriesKey: "tvdb:73244", type: "SERIES" });
    expect(uk).toBe(us);
  });

  it("separates two different shows that share a title", () => {
    const a = protectionKey({ parentTitle: "The Office", seriesKey: "tvdb:73244", type: "SERIES" });
    const b = protectionKey({ parentTitle: "The Office", seriesKey: "tvdb:78107", type: "SERIES" });
    expect(a).not.toBe(b);
  });

  it("falls back to the same title key a keyless row would compute", () => {
    // `seriesKeyFromTitle`, so a row that predates the `seriesKey` column still
    // collides with a backfilled one whose key came from the same title.
    expect(protectionKey({ parentTitle: " The Show ", seriesKey: null, type: "SERIES" })).toBe(
      protectionKey({ parentTitle: "the show", seriesKey: "title:the show", type: "SERIES" }),
    );
  });

  it("keys music on the artist title — there is no artist-identity column", () => {
    expect(protectionKey({ parentTitle: "Boards of Canada", type: "MUSIC" })).toBe(
      protectionKey({ parentTitle: "boards of canada", type: "MUSIC" }),
    );
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

    expect(
      result.has(protectionKey({ parentTitle: "The Office", seriesKey: "tvdb:73244", type: "SERIES" })!),
    ).toBe(true);
  });

  it("does not let a same-titled DIFFERENT show block one", async () => {
    // The other direction, which the title key got wrong too: an exception on
    // the 1978 Battlestar must not stop a delete of the 2004 one.
    mockPrisma.lifecycleException.findMany.mockResolvedValue([
      { mediaItem: { parentTitle: "Battlestar Galactica", seriesKey: "tvdb:71173", type: "SERIES" } },
    ]);

    const result = await findExceptionProtectedGroups("u1", [
      { parentTitle: "Battlestar Galactica", seriesKey: "tvdb:73545", type: "SERIES" },
    ]);

    expect(result.size).toBe(0);
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
            { parentTitle: { in: ["Protected Show"] } },
            { seriesKey: { in: ["tvdb:1"] } },
          ],
          type: { in: ["SERIES"] },
        },
      },
      select: {
        mediaItem: { select: { parentTitle: true, seriesKey: true, type: true } },
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
