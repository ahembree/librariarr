import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prismaMock, clientMock, catalogRef } = vi.hoisted(() => ({
  prismaMock: { trashManagedResource: { findMany: vi.fn(), updateMany: vi.fn() } },
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
  catalogRef: { current: null as unknown },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/trash/arr-guide-client", () => ({
  GuideArrClient: vi.fn(function () {
    return clientMock;
  }),
}));
vi.mock("@/lib/trash/catalog", () => ({ fetchTrashCatalog: vi.fn(async () => catalogRef.current) }));

import { runTrashSync } from "@/lib/trash/sync";
import { trashCfToArr } from "@/lib/trash/translate";
import type { TrashCustomFormat } from "@/lib/trash/types";

const CF: TrashCustomFormat = {
  trash_id: "cf1",
  name: "AMZN",
  trash_scores: { default: 100 },
  specifications: [{ name: "Amazon", implementation: "ReleaseTitleSpecification", fields: { value: "amzn" } }],
};

const SCHEMA = {
  name: "",
  upgradeAllowed: true,
  cutoff: 0,
  minFormatScore: 0,
  cutoffFormatScore: 0,
  items: [{ quality: { id: 3, name: "WEBDL-1080p" }, items: [], allowed: false }],
  formatItems: [{ format: 9, name: "AMZN", score: 0 }, { format: 8, name: "Other", score: 0 }],
};

function baseCatalog(service: "SONARR" | "RADARR") {
  return {
    service,
    ref: "master",
    fetchedAt: "2026-01-01T00:00:00Z",
    customFormats: [CF],
    qualityProfiles: [
      { trash_id: "qp1", name: "WEB-1080p", cutoff: "WEBDL-1080p", items: [{ name: "WEBDL-1080p", allowed: true }], formatItems: { AMZN: "cf1" } },
    ],
    qualitySize: { trash_id: "qs1", type: "series", qualities: [{ quality: "WEBDL-1080p", min: 1, max: 100 }] },
    naming: { series: { default: "{Series}" } },
  };
}

const SONARR = { serviceType: "SONARR" as const, id: "s1", name: "S", url: "http://s", apiKey: "k", enabled: true };

function row(over: Record<string, unknown>) {
  return { id: `row-${String(over.trashId)}`, name: String(over.trashId), selection: null, arrId: null, ...over };
}

/** findMany is called for the targets and (when profiles are targeted) again for overlays. */
function managedRows(rows: Record<string, unknown>[]) {
  prismaMock.trashManagedResource.findMany.mockImplementation(async (args: { where: { resourceType?: string } }) =>
    args.where.resourceType ? rows.filter((r) => r.resourceType === args.where.resourceType) : rows,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations; start every client stub from nothing.
  for (const fn of Object.values(clientMock)) fn.mockReset();
  catalogRef.current = baseCatalog("SONARR");
  managedRows([]);
  prismaMock.trashManagedResource.updateMany.mockResolvedValue({ count: 1 });
  clientMock.getCustomFormats.mockResolvedValue([]);
  clientMock.getQualityProfiles.mockResolvedValue([]);
  clientMock.getQualityProfileSchema.mockResolvedValue(SCHEMA);
  clientMock.getQualityDefinitions.mockResolvedValue([
    { id: 1, quality: { id: 3, name: "WEBDL-1080p" }, title: "WEBDL-1080p", weight: 1, minSize: 1, maxSize: 100, preferredSize: null },
  ]);
  clientMock.getNamingConfig.mockResolvedValue({ id: 1, seriesFolderFormat: "{Series}" });
  clientMock.createCustomFormat.mockResolvedValue({});
  clientMock.createQualityProfile.mockResolvedValue({});
});

describe("runTrashSync — skips and no-ops", () => {
  it("skips items the guide no longer has, naming them by trash id in a preview", async () => {
    catalogRef.current = { ...baseCatalog("SONARR"), naming: undefined };
    const report = await runTrashSync("u1", SONARR, {
      dryRun: true,
      items: [
        { resourceType: "CUSTOM_FORMAT", trashId: "gone-cf" },
        { resourceType: "QUALITY_PROFILE", trashId: "gone-qp" },
        { resourceType: "QUALITY_DEFINITION", trashId: "gone-qs" },
        { resourceType: "NAMING", trashId: "naming", selection: { series: "default" } },
      ],
    });
    expect(report.items.map((i) => [i.resourceType, i.action, i.name, i.warnings[0]])).toEqual([
      ["QUALITY_DEFINITION", "SKIP", "gone-qs", "Quality sizes are no longer in the guide."],
      ["NAMING", "SKIP", "naming", "Naming schemes are no longer in the guide."],
      ["CUSTOM_FORMAT", "SKIP", "gone-cf", "This custom format is no longer in the guide."],
      ["QUALITY_PROFILE", "SKIP", "gone-qp", "This quality profile is no longer in the guide."],
    ]);
    // Sonarr profiles carry no language: the language list is never read.
    expect(clientMock.getLanguages).not.toHaveBeenCalled();
  });

  it("skips quality sizes when the guide has none at all", async () => {
    catalogRef.current = { ...baseCatalog("SONARR"), qualitySize: undefined };
    const report = await runTrashSync("u1", SONARR, {
      dryRun: true,
      items: [{ resourceType: "QUALITY_DEFINITION", trashId: "qs1" }],
    });
    expect(report.items[0]).toMatchObject({
      action: "SKIP",
      warnings: ["Quality sizes are no longer in the guide."],
    });
    expect(clientMock.updateQualityDefinitions).not.toHaveBeenCalled();
  });

  it("reports NOOP and writes nothing to the app when everything already matches, but still stamps rows", async () => {
    managedRows([
      row({ resourceType: "CUSTOM_FORMAT", trashId: "cf1" }),
      row({ resourceType: "QUALITY_DEFINITION", trashId: "qs1" }),
      row({ resourceType: "NAMING", trashId: "naming", selection: { series: "default" } }),
    ]);
    clientMock.getCustomFormats.mockResolvedValue([trashCfToArr(CF, 5)]);

    const report = await runTrashSync("u1", SONARR, { dryRun: false });
    expect(report.items.map((i) => [i.resourceType, i.action, i.applied])).toEqual([
      ["QUALITY_DEFINITION", "NOOP", true],
      ["NAMING", "NOOP", true],
      ["CUSTOM_FORMAT", "NOOP", true],
    ]);
    expect(clientMock.updateCustomFormat).not.toHaveBeenCalled();
    expect(clientMock.updateQualityDefinitions).not.toHaveBeenCalled();
    expect(clientMock.updateNamingConfig).not.toHaveBeenCalled();
    expect(prismaMock.trashManagedResource.updateMany).toHaveBeenCalledTimes(3);
    expect(prismaMock.trashManagedResource.updateMany.mock.calls[2][0].data.arrId).toBe(5);
  });

  it("previews naming and quality-size updates without writing", async () => {
    clientMock.getNamingConfig.mockResolvedValue({ id: 1, seriesFolderFormat: "old" });
    clientMock.getQualityDefinitions.mockResolvedValue([
      { id: 1, quality: { id: 3, name: "WEBDL-1080p" }, title: "WEBDL-1080p", weight: 1, minSize: 0, maxSize: 50, preferredSize: null },
    ]);
    const report = await runTrashSync("u1", SONARR, {
      dryRun: true,
      items: [
        { resourceType: "NAMING", trashId: "naming", selection: { series: "default" } },
        { resourceType: "QUALITY_DEFINITION", trashId: "qs1" },
      ],
    });
    expect(report.items.map((i) => i.action)).toEqual(["UPDATE", "UPDATE"]);
    expect(report.items.every((i) => i.applied === undefined)).toBe(true);
    expect(clientMock.updateNamingConfig).not.toHaveBeenCalled();
    expect(prismaMock.trashManagedResource.updateMany).not.toHaveBeenCalled();
  });

  it("records an app id of null when the app returns none for a created format or profile", async () => {
    managedRows([
      row({ resourceType: "CUSTOM_FORMAT", trashId: "cf1" }),
      row({ resourceType: "QUALITY_PROFILE", trashId: "qp1" }),
    ]);
    const report = await runTrashSync("u1", SONARR, { dryRun: false });
    expect(report.items.map((i) => i.action)).toEqual(["CREATE", "CREATE"]);
    const datas = prismaMock.trashManagedResource.updateMany.mock.calls.map((c) => c[0].data);
    expect(datas.map((d) => d.arrId)).toEqual([null, null]);
  });

  it("turns a non-Error failure into an 'Unknown error' plan item", async () => {
    clientMock.getCustomFormats.mockRejectedValue("nope");
    const report = await runTrashSync("u1", SONARR, {
      dryRun: true,
      items: [{ resourceType: "CUSTOM_FORMAT", trashId: "cf1" }],
    });
    expect(report.items[0]).toMatchObject({ action: "ERROR", error: "Unknown error", name: "cf1" });
  });
});

describe("runTrashSync — quality profiles and overlays", () => {
  it("updates an existing profile, folding in overlays that target it by name or by id only", async () => {
    managedRows([
      row({ resourceType: "QUALITY_PROFILE", trashId: "qp1", arrId: 70 }),
      // Targets by the app id it last wrote to; its format is unknown to the guide (stored name used).
      row({ resourceType: "PROFILE_CF", trashId: "Renamed Elsewhere", arrId: 70, selection: { formats: [{ trashId: "zzz", name: "Other", score: 7 }] } }),
      // Targets a different profile: ignored for this one.
      row({ resourceType: "PROFILE_CF", trashId: "Unrelated", arrId: 999, selection: { formats: [{ trashId: "cf1", name: "AMZN", score: -5 }] } }),
      // No selection at all.
      row({ resourceType: "PROFILE_CF", trashId: "Empty", arrId: null, selection: null }),
    ]);
    const existing = {
      ...SCHEMA,
      id: 70,
      name: "My WEB",
      formatItems: [{ format: 9, name: "AMZN", score: 0 }, { format: 8, name: "Other", score: 0 }],
    };
    clientMock.getQualityProfiles.mockResolvedValue([existing]);

    const report = await runTrashSync("u1", SONARR, {
      dryRun: false,
      items: [{ resourceType: "QUALITY_PROFILE", trashId: "qp1" }],
    });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ action: "UPDATE", applied: true });
    const [id, payload] = clientMock.updateQualityProfile.mock.calls[0];
    expect(id).toBe(70);
    expect(Object.fromEntries(payload.formatItems.map((f: { name: string; score: number }) => [f.name, f.score]))).toEqual({
      AMZN: 100,
      Other: 7,
    });
  });

  it("a NOOP profile apply writes nothing to the app", async () => {
    managedRows([row({ resourceType: "QUALITY_PROFILE", trashId: "qp1" })]);
    const first = await runTrashSync("u1", SONARR, { dryRun: true, items: [{ resourceType: "QUALITY_PROFILE", trashId: "qp1" }] });
    expect(first.items[0].action).toBe("CREATE");

    // Feed back what a create would have produced, with an id.
    const { buildQualityProfile } = await import("@/lib/trash/translate");
    const { payload } = buildQualityProfile(
      (catalogRef.current as ReturnType<typeof baseCatalog>).qualityProfiles[0],
      SCHEMA,
      "SONARR",
      new Map([["cf1", CF]]),
    );
    clientMock.getQualityProfiles.mockResolvedValue([{ ...payload, id: 3 }]);
    const report = await runTrashSync("u1", SONARR, { dryRun: false });
    expect(report.items[0]).toMatchObject({ action: "NOOP", applied: true });
    expect(clientMock.updateQualityProfile).not.toHaveBeenCalled();
    expect(clientMock.createQualityProfile).not.toHaveBeenCalled();
  });

  it("PROFILE_CF with no selection, a profile without format items, and a format the app lacks", async () => {
    managedRows([row({ resourceType: "PROFILE_CF", trashId: "Bare", selection: null })]);
    clientMock.getQualityProfiles.mockResolvedValue([{ ...SCHEMA, id: 4, name: "Bare", formatItems: undefined }]);
    const report = await runTrashSync("u1", SONARR, { dryRun: false });
    expect(report.items[0]).toMatchObject({ action: "NOOP", applied: true, warnings: [] });
    expect(clientMock.updateQualityProfile).not.toHaveBeenCalled();

    const preview = await runTrashSync("u1", SONARR, {
      dryRun: true,
      items: [{ resourceType: "PROFILE_CF", trashId: "Bare", selection: { formats: [{ trashId: "cf1", name: "old", score: 10 }] } }],
    });
    expect(preview.items[0].warnings).toEqual([
      'Custom format "AMZN" is not present in this instance — add & sync it to apply its score.',
    ]);
    expect(preview.items[0].action).toBe("NOOP");
  });

  it("a PROFILE_CF profile with no id is treated as missing", async () => {
    clientMock.getQualityProfiles.mockResolvedValue([{ ...SCHEMA, name: "NoId" }]);
    const report = await runTrashSync("u1", SONARR, {
      dryRun: true,
      items: [{ resourceType: "PROFILE_CF", trashId: "NoId", selection: { formats: [] } }],
    });
    expect(report.items[0]).toMatchObject({
      action: "SKIP",
      warnings: ['Quality profile "NoId" was not found on this instance.'],
    });
  });
});

describe("runTrashSync — instance lock", () => {
  it("serialises concurrent applies on one instance and releases the lock afterwards", async () => {
    managedRows([row({ resourceType: "CUSTOM_FORMAT", trashId: "cf1" })]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    clientMock.getCustomFormats.mockImplementationOnce(async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
      return [];
    });
    clientMock.getCustomFormats.mockImplementation(async () => {
      order.push("second");
      return [];
    });

    const a = runTrashSync("u1", SONARR, { dryRun: false });
    const b = runTrashSync("u1", SONARR, { dryRun: false });
    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["first-start", "first-end", "second"]);

    // The lock is gone: a later apply runs straight away.
    await runTrashSync("u1", SONARR, { dryRun: false });
    expect(order).toEqual(["first-start", "first-end", "second", "second"]);
  });
});
