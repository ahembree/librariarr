import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  mediaItem: { aggregate: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

import { computeDeletedBytes } from "@/lib/lifecycle/deleted-bytes";

const item = { libraryId: "lib1", parentTitle: "Artist", seriesKey: null, fileSize: BigInt(7) };

describe("computeDeletedBytes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is null for an action that deletes nothing", async () => {
    expect(await computeDeletedBytes("UNMONITOR_RADARR", item, [], {})).toBeNull();
  });

  it("counts every track of the artist for a whole-artist Lidarr delete", async () => {
    mockPrisma.mediaItem.aggregate.mockResolvedValue({ _sum: { fileSize: BigInt(900) } });
    expect(await computeDeletedBytes("DELETE_LIDARR", item, ["t1"], {})).toBe(BigInt(900));
    expect(mockPrisma.mediaItem.aggregate).toHaveBeenCalledWith({
      where: { type: "MUSIC", libraryId: "lib1", parentTitle: "Artist" },
      _sum: { fileSize: true },
    });
  });

  it("counts the whole series for a whole-series Sonarr delete, by seriesKey", async () => {
    mockPrisma.mediaItem.aggregate.mockResolvedValue({ _sum: { fileSize: BigInt(500) } });
    await computeDeletedBytes("DELETE_SONARR", { ...item, parentTitle: "Show", seriesKey: "tvdb:1" }, [], {});
    expect(mockPrisma.mediaItem.aggregate).toHaveBeenCalledWith({
      where: { type: "SERIES", libraryId: "lib1", seriesKey: "tvdb:1" },
      _sum: { fileSize: true },
    });
  });

  it("counts only the members whose files a member-scoped delete reports deleted", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([{ fileSize: BigInt(3) }]);
    expect(await computeDeletedBytes("DELETE_FILES_SONARR", item, ["e1", "e2"], { deletedMemberIds: ["e2"] })).toBe(BigInt(3));
    expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith({ where: { id: { in: ["e2"] } }, select: { fileSize: true } });
  });

  it("is null when a member-scoped delete deleted nothing", async () => {
    expect(await computeDeletedBytes("DELETE_FILES_SONARR", item, ["e1"], { deletedMemberIds: [] })).toBeNull();
    expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
  });

  it("falls back to the members, then to the item itself", async () => {
    mockPrisma.mediaItem.findMany.mockResolvedValue([{ fileSize: BigInt(2) }, { fileSize: BigInt(4) }]);
    expect(await computeDeletedBytes("DELETE_FILES_SONARR", item, ["a", "b"], undefined)).toBe(BigInt(6));
    expect(await computeDeletedBytes("DELETE_RADARR", item, [], {})).toBe(BigInt(7));
  });
});
