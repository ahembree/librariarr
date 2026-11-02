import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  radarrInstance: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  sonarrInstance: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  lidarrInstance: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

import {
  ARR_FAMILY_FOR_TYPE,
  ARR_TYPE_FOR_FAMILY,
  countArrInstances,
  familyOfArrInstance,
  findArrInstance,
  findArrInstances,
} from "@/lib/arr/instances";

describe("Arr instance lookups", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps library types and families both ways", () => {
    for (const [type, family] of Object.entries(ARR_FAMILY_FOR_TYPE)) {
      expect(ARR_TYPE_FOR_FAMILY[family]).toBe(type);
    }
  });

  it("reads the family's own table, with the select when one is given", async () => {
    mockPrisma.sonarrInstance.findFirst.mockResolvedValue({ name: "Sonarr" });
    expect(await findArrInstance("SONARR", { id: "s1", userId: "u" }, { name: true })).toEqual({ name: "Sonarr" });
    expect(mockPrisma.sonarrInstance.findFirst).toHaveBeenCalledWith({ where: { id: "s1", userId: "u" }, select: { name: true } });

    mockPrisma.lidarrInstance.findFirst.mockResolvedValue(null);
    expect(await findArrInstance("LIDARR", { id: "l1" })).toBeNull();
    expect(mockPrisma.lidarrInstance.findFirst).toHaveBeenCalledWith({ where: { id: "l1" } });
    expect(mockPrisma.radarrInstance.findFirst).not.toHaveBeenCalled();
  });

  it("lists instances oldest first with a total order, and counts them", async () => {
    mockPrisma.radarrInstance.findMany.mockResolvedValue([]);
    await findArrInstances("RADARR", { userId: "u", enabled: true });
    expect(mockPrisma.radarrInstance.findMany).toHaveBeenCalledWith({
      where: { userId: "u", enabled: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    mockPrisma.lidarrInstance.count.mockResolvedValue(2);
    expect(await countArrInstances("LIDARR", { userId: "u" })).toBe(2);
  });

  it("names the family an instance id belongs to, probing the three tables together", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(null);
    mockPrisma.sonarrInstance.findFirst.mockResolvedValue({ id: "x", name: "Sonarr" });
    mockPrisma.lidarrInstance.findFirst.mockResolvedValue(null);
    expect(await familyOfArrInstance("x", "u")).toEqual({ family: "SONARR", instance: { id: "x", name: "Sonarr" } });
    for (const delegate of [mockPrisma.radarrInstance, mockPrisma.sonarrInstance, mockPrisma.lidarrInstance]) {
      expect(delegate.findFirst).toHaveBeenCalledWith({ where: { id: "x", userId: "u" } });
    }

    mockPrisma.sonarrInstance.findFirst.mockResolvedValue(null);
    expect(await familyOfArrInstance("x")).toBeNull();
    expect(mockPrisma.radarrInstance.findFirst).toHaveBeenLastCalledWith({ where: { id: "x" } });
  });
});
