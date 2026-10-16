import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPrisma, mockFetchCatalog, clientCtor, mockGetCfs, mockGetProfiles } = vi.hoisted(() => ({
  mockPrisma: {
    sonarrInstance: { findFirst: vi.fn(), findMany: vi.fn() },
    radarrInstance: { findFirst: vi.fn(), findMany: vi.fn() },
    trashManagedResource: { findMany: vi.fn() },
  },
  mockFetchCatalog: vi.fn(),
  clientCtor: vi.fn(),
  mockGetCfs: vi.fn(),
  mockGetProfiles: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/trash/catalog", () => ({ fetchTrashCatalog: mockFetchCatalog }));
vi.mock("@/lib/trash/arr-guide-client", () => ({
  GuideArrClient: vi.fn(function (this: Record<string, unknown>, ...args: unknown[]) {
    clientCtor(...args);
    this.getCustomFormats = mockGetCfs;
    this.getQualityProfiles = mockGetProfiles;
  }),
}));

import {
  computeTrashStatus,
  resolveInstance,
  listGuideInstances,
  managedInstanceWhere,
  guideClientFor,
  type ResolvedInstance,
} from "@/lib/trash/status";
import {
  trashCfHash,
  trashProfileHash,
  trashQualitySizeHash,
  namingSelectionHash,
} from "@/lib/trash/signature";
import type { TrashCatalog, TrashCustomFormat, TrashQualityProfile } from "@/lib/trash/types";

const RADARR: ResolvedInstance = {
  serviceType: "RADARR",
  id: "r1",
  name: "Radarr",
  url: "http://radarr:7878",
  apiKey: "k",
  enabled: true,
};
const SONARR: ResolvedInstance = { ...RADARR, serviceType: "SONARR", id: "s1", name: "Sonarr" };

const cfA: TrashCustomFormat = { trash_id: "cfA", name: "AMZN", specifications: [] };
const cfB: TrashCustomFormat = { trash_id: "cfB", name: "Bad", specifications: [], trash_scores: { default: -100 } };
const cfC: TrashCustomFormat = { trash_id: "cfC", name: "Renamed", specifications: [] };
const qp: TrashQualityProfile = {
  trash_id: "qp1",
  name: "HD Bluray",
  cutoff: "Bluray-1080p",
  items: [],
  formatItems: { Bad: "cfB" },
  trash_description: "Best <br> quality<b>!</b>",
};
const qp2: TrashQualityProfile = { trash_id: "qp2", name: "UHD", cutoff: "x", items: [] };

function catalog(over: Partial<TrashCatalog> = {}): TrashCatalog {
  return {
    service: "RADARR",
    ref: "master",
    fetchedAt: "2026-01-01T00:00:00Z",
    customFormats: [cfA, cfB, cfC],
    cfGroups: [],
    qualityProfiles: [qp, qp2],
    qualitySize: { trash_id: "qs", type: "movie", qualities: [{ quality: "HD", min: 1, max: 2 }] },
    naming: { file: { standard: "{Movie Title}" }, folder: { default: "{Movie Title} ({Release Year})" } },
    ...over,
  };
}

const synced = new Date("2026-02-01T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.trashManagedResource.findMany.mockResolvedValue([]);
  mockFetchCatalog.mockResolvedValue(catalog());
  mockGetCfs.mockResolvedValue([]);
  mockGetProfiles.mockResolvedValue([]);
});

describe("managedInstanceWhere / guideClientFor", () => {
  it("selects the right instance column per service", () => {
    expect(managedInstanceWhere("SONARR", "x")).toEqual({ sonarrInstanceId: "x" });
    expect(managedInstanceWhere("RADARR", "x")).toEqual({ radarrInstanceId: "x" });
  });

  it("builds a guide client from the instance", () => {
    guideClientFor(SONARR);
    expect(clientCtor).toHaveBeenCalledWith("http://radarr:7878", "k", "SONARR");
  });
});

describe("resolveInstance", () => {
  const row = { id: "i", name: "N", url: "http://u", apiKey: "a", enabled: false, extra: 1 };

  it("resolves a Sonarr instance scoped to the user", async () => {
    mockPrisma.sonarrInstance.findFirst.mockResolvedValue(row);
    await expect(resolveInstance("u1", "SONARR", "i")).resolves.toEqual({
      serviceType: "SONARR", id: "i", name: "N", url: "http://u", apiKey: "a", enabled: false,
    });
    expect(mockPrisma.sonarrInstance.findFirst).toHaveBeenCalledWith({ where: { id: "i", userId: "u1" } });
    expect(mockPrisma.radarrInstance.findFirst).not.toHaveBeenCalled();
  });

  it("resolves a Radarr instance", async () => {
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(row);
    const r = await resolveInstance("u1", "RADARR", "i");
    expect(r?.serviceType).toBe("RADARR");
  });

  it("returns null when not found", async () => {
    mockPrisma.sonarrInstance.findFirst.mockResolvedValue(null);
    mockPrisma.radarrInstance.findFirst.mockResolvedValue(null);
    expect(await resolveInstance("u1", "SONARR", "x")).toBeNull();
    expect(await resolveInstance("u1", "RADARR", "x")).toBeNull();
  });
});

describe("listGuideInstances", () => {
  it("lists Sonarr then Radarr instances, tagged by service and without secrets", async () => {
    mockPrisma.sonarrInstance.findMany.mockResolvedValue([{ id: "s", name: "S", enabled: true, apiKey: "x" }]);
    mockPrisma.radarrInstance.findMany.mockResolvedValue([{ id: "r", name: "R", enabled: false, apiKey: "y" }]);
    await expect(listGuideInstances("u1")).resolves.toEqual([
      { serviceType: "SONARR", id: "s", name: "S", enabled: true },
      { serviceType: "RADARR", id: "r", name: "R", enabled: false },
    ]);
  });
});

describe("computeTrashStatus", () => {
  it("reports a catalog outage separately, keeping the instance reachable", async () => {
    mockPrisma.trashManagedResource.findMany.mockResolvedValue([
      { id: "m1", resourceType: "PROFILE_CF", trashId: "x", arrId: null, selection: null, lastSyncedAt: null, lastSyncHash: null },
      { id: "m2", resourceType: "PROFILE_CF", trashId: "y", arrId: null, selection: null, lastSyncedAt: null, lastSyncHash: null },
    ]);
    mockFetchCatalog.mockRejectedValue(new Error("GitHub down at 192.168.1.5"));
    const s = await computeTrashStatus("u1", RADARR);
    expect(s).toMatchObject({ reachable: true, items: [], managedProfileCf: 2 });
    expect(s.catalogError).toBe("GitHub down at [internal]");
    expect(mockPrisma.trashManagedResource.findMany).toHaveBeenCalledWith({
      where: { userId: "u1", radarrInstanceId: "r1" },
    });
    expect(mockGetCfs).not.toHaveBeenCalled();
  });

  it("uses a generic catalog error for a non-Error rejection", async () => {
    mockFetchCatalog.mockRejectedValue("nope");
    const s = await computeTrashStatus("u1", SONARR);
    expect(s.catalogError).toBe("The TRaSH guide catalog is temporarily unavailable.");
    expect(mockPrisma.trashManagedResource.findMany).toHaveBeenCalledWith({
      where: { userId: "u1", sonarrInstanceId: "s1" },
    });
  });

  it("reports an unreachable instance with a sanitised error", async () => {
    mockGetCfs.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.2:7878"));
    const s = await computeTrashStatus("u1", RADARR);
    expect(s.reachable).toBe(false);
    expect(s.error).toBe("connect ECONNREFUSED [internal]:7878");
    expect(s.items).toEqual([]);
  });

  it("falls back to a generic message for an unreachable instance without an error message", async () => {
    mockGetProfiles.mockRejectedValue({});
    const s = await computeTrashStatus("u1", RADARR);
    expect(s).toMatchObject({ reachable: false, error: "Unable to reach instance" });
  });

  it("cross-references every resource kind into per-item statuses", async () => {
    const qpSelection = { scoreSet: "sqp-1" };
    const namingSelection = { file: "standard", folder: "default" };
    const cat = catalog();
    const cfMap = new Map(cat.customFormats.map((c) => [c.trash_id, c]));
    mockPrisma.trashManagedResource.findMany.mockResolvedValue([
      // Managed + in sync.
      { id: "mA", resourceType: "CUSTOM_FORMAT", trashId: "cfA", arrId: 5, selection: null, lastSyncedAt: synced, lastSyncHash: trashCfHash(cfA) },
      // Managed but deleted from the Arr.
      { id: "mB", resourceType: "CUSTOM_FORMAT", trashId: "cfB", arrId: 6, selection: null, lastSyncedAt: null, lastSyncHash: "h" },
      // Managed, renamed in the app — found by recorded id; guide changed upstream.
      { id: "mC", resourceType: "CUSTOM_FORMAT", trashId: "cfC", arrId: 9, selection: null, lastSyncedAt: synced, lastSyncHash: "stale" },
      // Managed profile in sync with its selection folded into the hash.
      { id: "mQ", resourceType: "QUALITY_PROFILE", trashId: "qp1", arrId: 1, selection: qpSelection, lastSyncedAt: synced, lastSyncHash: trashProfileHash(qp, cfMap, qpSelection) },
      // Managed quality sizes, never synced yet.
      { id: "mS", resourceType: "QUALITY_DEFINITION", trashId: "qs", arrId: null, selection: null, lastSyncedAt: null, lastSyncHash: null },
      // Managed naming in sync.
      { id: "mN", resourceType: "NAMING", trashId: "naming", arrId: null, selection: namingSelection, lastSyncedAt: synced, lastSyncHash: namingSelectionHash(cat.naming!, namingSelection, "RADARR") },
      { id: "mP", resourceType: "PROFILE_CF", trashId: "qp1", arrId: null, selection: null, lastSyncedAt: null, lastSyncHash: null },
    ]);
    mockGetCfs.mockResolvedValue([
      { id: 5, name: "amzn" },
      { id: 9, name: "My Renamed CF" },
    ]);
    mockGetProfiles.mockResolvedValue([{ id: 1, name: "HD Bluray" }, { id: 2, name: "UHD" }]);

    const s = await computeTrashStatus("u1", RADARR);
    expect(s.reachable).toBe(true);
    expect(s.managedProfileCf).toBe(1);
    const by = Object.fromEntries(s.items.map((i) => [`${i.resourceType}:${i.trashId}`, i]));

    expect(by["CUSTOM_FORMAT:cfA"]).toMatchObject({
      status: "MANAGED", existsInArr: true, managed: true, arrId: 5, managedResourceId: "mA",
      lastSyncedAt: synced.toISOString(),
    });
    expect(by["CUSTOM_FORMAT:cfB"]).toMatchObject({
      status: "MANAGED_MISSING", existsInArr: false, arrId: 6, lastSyncedAt: null,
    });
    expect(by["CUSTOM_FORMAT:cfC"]).toMatchObject({ status: "MANAGED_OUTDATED", existsInArr: true, arrId: 9 });

    expect(by["QUALITY_PROFILE:qp1"]).toMatchObject({
      status: "MANAGED", arrId: 1, description: "Best · quality!", selection: qpSelection,
    });
    // An unmanaged profile that already exists in the app needs take-over consent.
    expect(by["QUALITY_PROFILE:qp2"]).toMatchObject({
      status: "UNMANAGED_CONFLICT", managed: false, arrId: 2, selection: null,
    });
    expect(by["QUALITY_PROFILE:qp2"].description).toBeUndefined();

    expect(by["QUALITY_DEFINITION:qs"]).toMatchObject({
      status: "MANAGED_OUTDATED", existsInArr: true, arrId: null, name: "Quality Sizes (movie)",
    });
    expect(by["NAMING:naming"]).toMatchObject({ status: "MANAGED", selection: namingSelection });
    // PROFILE_CF rows are not listed as items.
    expect(s.items.some((i) => i.resourceType === "PROFILE_CF")).toBe(false);
  });

  it("marks unmanaged, absent resources NEW and unmanaged sizes/naming as conflicts", async () => {
    const s = await computeTrashStatus("u1", RADARR);
    const by = Object.fromEntries(s.items.map((i) => [`${i.resourceType}:${i.trashId}`, i]));
    expect(by["CUSTOM_FORMAT:cfA"]).toMatchObject({ status: "NEW", existsInArr: false, managed: false, arrId: null });
    expect(by["QUALITY_PROFILE:qp1"].status).toBe("NEW");
    // Sizes and naming always exist on an instance.
    expect(by["QUALITY_DEFINITION:qs"].status).toBe("UNMANAGED_CONFLICT");
    expect(by["NAMING:naming"]).toMatchObject({ status: "UNMANAGED_CONFLICT", selection: null });
  });

  it("flags a managed quality-size whose guide changed, and a managed naming row with no selection", async () => {
    mockPrisma.trashManagedResource.findMany.mockResolvedValue([
      { id: "mS", resourceType: "QUALITY_DEFINITION", trashId: "qs", arrId: null, selection: null, lastSyncedAt: synced, lastSyncHash: "old" },
      { id: "mN", resourceType: "NAMING", trashId: "naming", arrId: null, selection: null, lastSyncedAt: synced, lastSyncHash: "anything" },
    ]);
    const s = await computeTrashStatus("u1", RADARR);
    const by = Object.fromEntries(s.items.map((i) => [`${i.resourceType}:${i.trashId}`, i]));
    expect(by["QUALITY_DEFINITION:qs"].status).toBe("MANAGED_OUTDATED");
    // No selection → no current hash to compare against, so a synced row reads in sync.
    expect(by["NAMING:naming"].status).toBe("MANAGED");
  });

  it("reports a managed quality-size matching the guide as in sync", async () => {
    const cat = catalog();
    mockPrisma.trashManagedResource.findMany.mockResolvedValue([
      { id: "mS", resourceType: "QUALITY_DEFINITION", trashId: "qs", arrId: null, selection: null, lastSyncedAt: synced, lastSyncHash: trashQualitySizeHash(cat.qualitySize!) },
    ]);
    const s = await computeTrashStatus("u1", RADARR);
    expect(s.items.find((i) => i.resourceType === "QUALITY_DEFINITION")?.status).toBe("MANAGED");
  });

  it("omits quality sizes and naming when the guide has none", async () => {
    mockFetchCatalog.mockResolvedValue(catalog({ qualitySize: null, naming: null }));
    const s = await computeTrashStatus("u1", RADARR);
    expect(s.items.map((i) => i.resourceType)).toEqual([
      "CUSTOM_FORMAT", "CUSTOM_FORMAT", "CUSTOM_FORMAT", "QUALITY_PROFILE", "QUALITY_PROFILE",
    ]);
  });
});
