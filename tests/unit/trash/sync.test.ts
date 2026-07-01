import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    trashManagedResource: { findMany: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getCustomFormats: vi.fn(),
    getQualityProfiles: vi.fn(),
    getQualityProfileSchema: vi.fn(),
    createCustomFormat: vi.fn(),
    updateCustomFormat: vi.fn(),
    createQualityProfile: vi.fn(),
    updateQualityProfile: vi.fn(),
    getQualityDefinitions: vi.fn(),
    updateQualityDefinitions: vi.fn(),
    getNamingConfig: vi.fn(),
    updateNamingConfig: vi.fn(),
  },
}));
vi.mock("@/lib/trash/arr-guide-client", () => ({
  GuideArrClient: vi.fn(function () {
    return clientMock;
  }),
}));

const CATALOG = {
  service: "RADARR",
  ref: "master",
  fetchedAt: "2026-01-01T00:00:00Z",
  customFormats: [
    {
      trash_id: "cf1",
      name: "AMZN",
      includeCustomFormatWhenRenaming: true,
      trash_scores: { default: 100 },
      specifications: [
        { name: "Amazon", implementation: "ReleaseTitleSpecification", negate: false, required: true, fields: { value: "amzn" } },
      ],
    },
  ],
  qualityProfiles: [],
  qualitySize: { trash_id: "qs1", type: "movie", qualities: [{ quality: "Bluray-1080p", min: 5, preferred: 100, max: 200 }] },
  naming: { folder: { default: "{Movie CleanTitle}" }, file: { standard: "{Movie CleanTitle} {Quality Full}" } },
};
vi.mock("@/lib/trash/catalog", () => ({ fetchTrashCatalog: vi.fn(async () => CATALOG) }));

import { runTrashSync } from "@/lib/trash/sync";

const INST = { serviceType: "RADARR" as const, id: "r1", name: "R", url: "http://r", apiKey: "k", enabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  clientMock.getCustomFormats.mockResolvedValue([]);
  clientMock.getQualityDefinitions.mockResolvedValue([
    { id: 1, quality: { id: 7, name: "Bluray-1080p" }, title: "Bluray-1080p", weight: 1, minSize: 0, maxSize: 100, preferredSize: 95 },
  ]);
  clientMock.createCustomFormat.mockResolvedValue({ id: 500 });
  clientMock.updateQualityDefinitions.mockResolvedValue([]);
});

describe("runTrashSync", () => {
  it("dry-run previews without writing to the Arr or DB", async () => {
    const report = await runTrashSync("u1", INST, {
      dryRun: true,
      items: [{ resourceType: "CUSTOM_FORMAT", trashId: "cf1" }],
    });
    expect(report.dryRun).toBe(true);
    expect(report.items[0].action).toBe("CREATE");
    expect(report.items[0].diff.length).toBeGreaterThan(0);
    expect(clientMock.createCustomFormat).not.toHaveBeenCalled();
    expect(prismaMock.trashManagedResource.update).not.toHaveBeenCalled();
    // Preview items don't consult the managed set.
    expect(prismaMock.trashManagedResource.findMany).not.toHaveBeenCalled();
  });

  it("apply creates the resource and stamps the managed row", async () => {
    prismaMock.trashManagedResource.findMany.mockResolvedValue([
      { id: "row1", resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN", selection: null },
    ]);
    const report = await runTrashSync("u1", INST, { dryRun: false });
    expect(report.items[0].action).toBe("CREATE");
    expect(report.items[0].applied).toBe(true);
    expect(clientMock.createCustomFormat).toHaveBeenCalledTimes(1);
    expect(prismaMock.trashManagedResource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "row1" },
        data: expect.objectContaining({ arrId: 500 }),
      }),
    );
  });

  it("apply with items only writes the matching managed rows (per-item sync)", async () => {
    prismaMock.trashManagedResource.findMany.mockResolvedValue([
      { id: "cfRow", resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN", selection: null },
      { id: "qdRow", resourceType: "QUALITY_DEFINITION", trashId: "qs1", name: "Sizes", selection: null },
    ]);
    const report = await runTrashSync("u1", INST, {
      dryRun: false,
      items: [{ resourceType: "CUSTOM_FORMAT", trashId: "cf1" }],
    });
    expect(report.items).toHaveLength(1);
    expect(report.items[0].resourceType).toBe("CUSTOM_FORMAT");
    expect(clientMock.createCustomFormat).toHaveBeenCalledTimes(1);
    expect(clientMock.updateQualityDefinitions).not.toHaveBeenCalled();
  });

  it("processes quality definitions before custom formats", async () => {
    prismaMock.trashManagedResource.findMany.mockResolvedValue([
      { id: "cfRow", resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN", selection: null },
      { id: "qdRow", resourceType: "QUALITY_DEFINITION", trashId: "qs1", name: "Sizes", selection: null },
    ]);
    const report = await runTrashSync("u1", INST, { dryRun: true });
    expect(report.items[0].resourceType).toBe("QUALITY_DEFINITION");
    expect(report.items[1].resourceType).toBe("CUSTOM_FORMAT");
  });

  it("skips naming with no selection", async () => {
    prismaMock.trashManagedResource.findMany.mockResolvedValue([
      { id: "n", resourceType: "NAMING", trashId: "naming", name: "Naming", selection: null },
    ]);
    clientMock.getNamingConfig.mockResolvedValue({ id: 1, standardMovieFormat: "old", movieFolderFormat: "old" });
    const report = await runTrashSync("u1", INST, { dryRun: true });
    expect(report.items[0].action).toBe("SKIP");
  });
});
