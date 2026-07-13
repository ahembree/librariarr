import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  lifecycleException: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

import {
  findExceptionProtectedParents,
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

describe("findExceptionProtectedParents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty set without querying when no item has a parentTitle (movies)", async () => {
    const result = await findExceptionProtectedParents("u1", [
      { parentTitle: null, type: "MOVIE" },
    ]);
    expect(result.size).toBe(0);
    expect(mockPrisma.lifecycleException.findMany).not.toHaveBeenCalled();
  });

  it("returns parents that have ANY excepted episode/track", async () => {
    mockPrisma.lifecycleException.findMany.mockResolvedValue([
      { mediaItem: { parentTitle: "Protected Show" } },
    ]);

    const result = await findExceptionProtectedParents("u1", [
      { parentTitle: "Protected Show", type: "SERIES" },
      { parentTitle: "Other Show", type: "SERIES" },
    ]);

    expect(result.has("Protected Show")).toBe(true);
    expect(result.has("Other Show")).toBe(false);
    expect(mockPrisma.lifecycleException.findMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        mediaItem: {
          parentTitle: { in: ["Protected Show", "Other Show"] },
          type: { in: ["SERIES"] },
        },
      },
      select: { mediaItem: { select: { parentTitle: true } } },
    });
  });

  it("scopes the exception lookup to the items' media types", async () => {
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);

    await findExceptionProtectedParents("u1", [
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

  it("returns an empty set when no exceptions exist for the parents", async () => {
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    const result = await findExceptionProtectedParents("u1", [
      { parentTitle: "Show", type: "SERIES" },
    ]);
    expect(result.size).toBe(0);
  });
});
