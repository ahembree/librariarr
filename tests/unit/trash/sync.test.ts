import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    trashManagedResource: { findMany: vi.fn(), updateMany: vi.fn() },
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
    getLanguages: vi.fn(),
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
    expect(prismaMock.trashManagedResource.updateMany).not.toHaveBeenCalled();
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
    expect(prismaMock.trashManagedResource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "row1", userId: "u1" },
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

  it("reads the instance once per run even when that read fails", async () => {
    // An unreachable instance costs the client's whole retry budget per read;
    // every target that needs the same data must fail on the first failure
    // rather than asking again.
    CATALOG.customFormats.push({ ...CATALOG.customFormats[0], trash_id: "cf2", name: "NF" });
    try {
      clientMock.getCustomFormats.mockRejectedValue(new Error("Radarr HTTP 503"));
      const report = await runTrashSync("u1", INST, {
        dryRun: true,
        items: [
          { resourceType: "CUSTOM_FORMAT", trashId: "cf1" },
          { resourceType: "CUSTOM_FORMAT", trashId: "cf2" },
        ],
      });
      expect(report.items.map((i) => i.action)).toEqual(["ERROR", "ERROR"]);
      expect(clientMock.getCustomFormats).toHaveBeenCalledTimes(1);
    } finally {
      CATALOG.customFormats.pop();
    }
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

  it("PROFILE_CF overlays scores onto the target profile, preserving other scores", async () => {
    prismaMock.trashManagedResource.findMany.mockResolvedValue([
      {
        id: "pcf",
        resourceType: "PROFILE_CF",
        trashId: "My Profile",
        name: "My Profile",
        selection: { formats: [{ trashId: "cf1", name: "AMZN", score: 500 }] },
      },
    ]);
    clientMock.getQualityProfiles.mockResolvedValue([
      {
        id: 9,
        name: "My Profile",
        formatItems: [
          { format: 55, name: "AMZN", score: 0 },
          { format: 56, name: "Other", score: 100 },
        ],
      },
    ]);
    clientMock.updateQualityProfile.mockResolvedValue({});
    const report = await runTrashSync("u1", INST, { dryRun: false });
    expect(report.items[0].resourceType).toBe("PROFILE_CF");
    expect(report.items[0].action).toBe("UPDATE");
    expect(clientMock.updateQualityProfile).toHaveBeenCalledTimes(1);
    const [id, payload] = clientMock.updateQualityProfile.mock.calls[0] as [number, { formatItems: { name: string; score: number }[] }];
    expect(id).toBe(9);
    expect(payload.formatItems.find((f) => f.name === "AMZN")?.score).toBe(500);
    expect(payload.formatItems.find((f) => f.name === "Other")?.score).toBe(100);
  });

  it("PROFILE_CF skips when the target profile no longer exists", async () => {
    prismaMock.trashManagedResource.findMany.mockResolvedValue([
      { id: "pcf", resourceType: "PROFILE_CF", trashId: "Ghost", name: "Ghost", selection: { formats: [] } },
    ]);
    clientMock.getQualityProfiles.mockResolvedValue([]);
    const report = await runTrashSync("u1", INST, { dryRun: false });
    expect(report.items[0].action).toBe("SKIP");
    expect(clientMock.updateQualityProfile).not.toHaveBeenCalled();
  });

  it("skips naming with no selection", async () => {
    prismaMock.trashManagedResource.findMany.mockResolvedValue([
      { id: "n", resourceType: "NAMING", trashId: "naming", name: "Naming", selection: null },
    ]);
    clientMock.getNamingConfig.mockResolvedValue({ id: 1, standardMovieFormat: "old", movieFolderFormat: "old" });
    const report = await runTrashSync("u1", INST, { dryRun: true });
    expect(report.items[0].action).toBe("SKIP");
  });

  it("finds a managed custom format renamed upstream by its recorded id instead of creating a duplicate", async () => {
    prismaMock.trashManagedResource.findMany.mockResolvedValue([
      { id: "row1", resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN", selection: null, arrId: 42 },
    ]);
    clientMock.getCustomFormats.mockResolvedValue([
      { id: 42, name: "Amazon (old name)", includeCustomFormatWhenRenaming: true, specifications: [] },
    ]);
    clientMock.updateCustomFormat.mockResolvedValue({});
    const report = await runTrashSync("u1", INST, { dryRun: false });
    expect(report.items[0].action).toBe("UPDATE");
    expect(clientMock.createCustomFormat).not.toHaveBeenCalled();
    expect(clientMock.updateCustomFormat).toHaveBeenCalledWith(42, expect.objectContaining({ name: "AMZN" }));
  });

  it("prefers the guide-name match over the recorded id", async () => {
    prismaMock.trashManagedResource.findMany.mockResolvedValue([
      { id: "row1", resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN", selection: null, arrId: 42 },
    ]);
    clientMock.getCustomFormats.mockResolvedValue([
      { id: 42, name: "Something else", specifications: [] },
      { id: 7, name: "amzn", specifications: [] },
    ]);
    clientMock.updateCustomFormat.mockResolvedValue({});
    await runTrashSync("u1", INST, { dryRun: false });
    expect(clientMock.updateCustomFormat).toHaveBeenCalledWith(7, expect.anything());
  });

  it("updateMany tolerates a row unmanaged mid-sync (the app write already landed)", async () => {
    prismaMock.trashManagedResource.findMany.mockResolvedValue([
      { id: "row1", resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN", selection: null },
    ]);
    prismaMock.trashManagedResource.updateMany.mockResolvedValue({ count: 0 });
    const report = await runTrashSync("u1", INST, { dryRun: false });
    expect(report.items[0].action).toBe("CREATE");
    expect(report.items[0].applied).toBe(true);
  });

  it("PROFILE_CF resolves format names through the guide and finds a renamed profile by id", async () => {
    prismaMock.trashManagedResource.findMany.mockResolvedValue([
      {
        id: "pcf",
        resourceType: "PROFILE_CF",
        trashId: "Old Profile Name",
        name: "Old Profile Name",
        arrId: 9,
        // Stored name is stale — the guide calls cf1 "AMZN" now.
        selection: { formats: [{ trashId: "cf1", name: "Amazon", score: 500 }] },
      },
    ]);
    clientMock.getQualityProfiles.mockResolvedValue([
      { id: 9, name: "New Profile Name", formatItems: [{ format: 55, name: "amzn", score: 0 }] },
    ]);
    clientMock.updateQualityProfile.mockResolvedValue({});
    const report = await runTrashSync("u1", INST, { dryRun: false });
    expect(report.items[0].action).toBe("UPDATE");
    expect(report.items[0].warnings).toEqual([]);
    const [id, payload] = clientMock.updateQualityProfile.mock.calls[0] as [number, { formatItems: { name: string; score: number }[] }];
    expect(id).toBe(9);
    expect(payload.formatItems[0].score).toBe(500);
  });
});

describe("runTrashSync — quality profiles", () => {
  const QP = {
    trash_id: "qp1",
    name: "HD",
    cutoff: "Bluray-1080p",
    items: [{ name: "Bluray-1080p", allowed: true }],
    formatItems: { AMZN: "cf1" },
  };
  const SCHEMA = {
    items: [{ quality: { id: 7, name: "Bluray-1080p" }, items: [], allowed: false }],
    formatItems: [
      { format: 55, name: "AMZN", score: 0 },
      { format: 56, name: "Mine", score: 0 },
    ],
    language: { id: 1, name: "English" },
  };

  beforeEach(() => {
    (CATALOG.qualityProfiles as unknown[]).push(QP);
    clientMock.getQualityProfileSchema.mockResolvedValue(SCHEMA);
    clientMock.getLanguages.mockResolvedValue([{ id: 1, name: "English" }]);
    clientMock.updateQualityProfile.mockResolvedValue({});
  });
  afterEach(() => {
    CATALOG.qualityProfiles.length = 0;
  });

  function rows(...extra: Array<{ resourceType: string } & Record<string, unknown>>) {
    const all = [
      { id: "qpRow", resourceType: "QUALITY_PROFILE", trashId: "qp1", name: "HD", selection: { resetUnmatchedScores: true }, arrId: 3 },
      ...extra,
    ];
    prismaMock.trashManagedResource.findMany.mockImplementation(
      async ({ where }: { where: { resourceType?: string } }) =>
        where.resourceType ? all.filter((r) => r.resourceType === where.resourceType) : all,
    );
  }

  it("a profile-only sync keeps the profile's PROFILE_CF overlay scores, even with reset on", async () => {
    rows({
      id: "pcf",
      resourceType: "PROFILE_CF",
      trashId: "HD",
      name: "HD",
      arrId: 3,
      selection: { formats: [{ trashId: "cf1", name: "AMZN", score: 7 }] },
    });
    clientMock.getQualityProfiles.mockResolvedValue([
      {
        id: 3,
        name: "HD",
        upgradeAllowed: true,
        cutoff: 7,
        minFormatScore: 0,
        cutoffFormatScore: 0,
        minUpgradeFormatScore: 1,
        items: [{ quality: { id: 7, name: "Bluray-1080p" }, items: [], allowed: true }],
        formatItems: [
          { format: 55, name: "AMZN", score: 7 },
          { format: 56, name: "Mine", score: 0 },
        ],
        language: { id: 1, name: "English" },
      },
    ]);
    const report = await runTrashSync("u1", INST, {
      dryRun: false,
      items: [{ resourceType: "QUALITY_PROFILE", trashId: "qp1" }],
    });
    expect(report.items).toHaveLength(1);
    // The guide would score AMZN 100; the overlay's 7 wins, so nothing changes.
    expect(report.items[0].action).toBe("NOOP");
  });

  it("does not record the guide hash when a referenced format is missing from the app", async () => {
    rows();
    clientMock.getQualityProfileSchema.mockResolvedValue({ ...SCHEMA, formatItems: [] });
    clientMock.getQualityProfiles.mockResolvedValue([]);
    clientMock.createQualityProfile.mockResolvedValue({ id: 3 });
    const report = await runTrashSync("u1", INST, { dryRun: false });
    expect(report.items[0].warnings.join(" ")).toMatch(/not present/);
    expect(prismaMock.trashManagedResource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastSyncHash: null }) }),
    );
  });
});
