import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestSonarrInstance,
  createTestRadarrInstance,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Canned guide catalog so tests don't hit the network.
const CATALOG = {
  service: "RADARR",
  ref: "master",
  fetchedAt: "2026-01-01T00:00:00Z",
  customFormats: [
    {
      trash_id: "cf1",
      name: "AMZN",
      includeCustomFormatWhenRenaming: true,
      trash_scores: { default: 100, "sqp-1-2160p": -25 },
      specifications: [
        { name: "Amazon", implementation: "ReleaseTitleSpecification", negate: false, required: true, fields: { value: "amzn" } },
      ],
    },
  ],
  qualityProfiles: [
    {
      trash_id: "qp1",
      name: "HD Bluray + WEB",
      trash_description: "desc",
      cutoff: "Bluray-1080p",
      upgradeAllowed: true,
      minFormatScore: 0,
      cutoffFormatScore: 10000,
      minUpgradeFormatScore: 1,
      items: [{ name: "Bluray-1080p", allowed: true }],
      formatItems: { AMZN: "cf1" },
    },
  ],
  qualitySize: { trash_id: "qs1", type: "movie", qualities: [{ quality: "Bluray-1080p", min: 5, preferred: 100, max: 200 }] },
  naming: { folder: { default: "{Movie CleanTitle}" }, file: { standard: "{Movie CleanTitle} {Quality Full}" } },
  cfGroups: [{ name: "[Audio] Audio Formats", trash_id: "g1", customFormats: ["cf1"] }],
};

// A distinct Sonarr catalog (different trash_ids) so the cross-service gate is
// exercised: a Radarr trash_id must be rejected on a Sonarr instance.
const SONARR_CATALOG = {
  service: "SONARR",
  ref: "master",
  fetchedAt: "2026-01-01T00:00:00Z",
  customFormats: [{ trash_id: "scf1", name: "Sonarr CF", specifications: [] }],
  qualityProfiles: [{ trash_id: "sqp1", name: "WEB-1080p", items: [] }],
  qualitySize: { trash_id: "sqs1", type: "series", qualities: [] },
  naming: { series: { default: "{Series Title}" } },
  cfGroups: [],
};

// Keep the real `catalogHasResource` (the route imports it) but stub the fetch.
vi.mock("@/lib/trash/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trash/catalog")>();
  return {
    ...actual,
    fetchTrashCatalog: vi.fn(async (svc: string) => (svc === "SONARR" ? SONARR_CATALOG : CATALOG)),
  };
});

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getCustomFormats: vi.fn(),
    getQualityProfiles: vi.fn(),
    getQualityProfileSchema: vi.fn(),
    getLanguages: vi.fn(),
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

import { GET as getInstances } from "@/app/api/tools/trash/instances/route";
import { GET as getCatalog } from "@/app/api/tools/trash/catalog/route";
import { GET as getStatus } from "@/app/api/tools/trash/status/route";
import { GET as getAssignments, POST as postAssignment } from "@/app/api/tools/trash/assignments/route";
import { DELETE as deleteAssignment, PUT as putAssignment } from "@/app/api/tools/trash/assignments/[id]/route";
import { POST as postSync } from "@/app/api/tools/trash/sync/route";
import { GET as getProfiles } from "@/app/api/tools/trash/profiles/route";
import { trashCfHash } from "@/lib/trash/signature";
import type { TrashCustomFormat } from "@/lib/trash/types";
import { getTestPrisma } from "../../setup/test-db";

const SCHEMA = {
  name: "",
  upgradeAllowed: true,
  cutoff: 0,
  minFormatScore: 0,
  cutoffFormatScore: 0,
  minUpgradeFormatScore: 1,
  language: { id: -1, name: "Any" },
  items: [{ quality: { id: 7, name: "Bluray-1080p" }, items: [], allowed: false }],
  formatItems: [{ format: 55, name: "AMZN", score: 0 }],
};

function defaultClient() {
  clientMock.getCustomFormats.mockResolvedValue([]);
  clientMock.getQualityProfiles.mockResolvedValue([]);
  clientMock.getQualityProfileSchema.mockResolvedValue(SCHEMA);
  clientMock.getLanguages.mockResolvedValue([{ id: -1, name: "Any" }]);
  clientMock.getQualityDefinitions.mockResolvedValue([
    { id: 1, quality: { id: 7, name: "Bluray-1080p" }, title: "Bluray-1080p", weight: 1, minSize: 0, maxSize: 100, preferredSize: 95 },
  ]);
  clientMock.getNamingConfig.mockResolvedValue({ id: 1, standardMovieFormat: "old", movieFolderFormat: "old" });
  clientMock.createCustomFormat.mockResolvedValue({ id: 500 });
  clientMock.createQualityProfile.mockResolvedValue({ id: 600 });
  clientMock.updateCustomFormat.mockResolvedValue({});
  clientMock.updateQualityProfile.mockResolvedValue({});
  clientMock.updateQualityDefinitions.mockResolvedValue([]);
  clientMock.updateNamingConfig.mockResolvedValue({});
}

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
  defaultClient();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function authedUserWithRadarr() {
  const user = await createTestUser();
  setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
  const radarr = await createTestRadarrInstance(user.id);
  return { user, radarr };
}

describe("GET /api/tools/trash/instances", () => {
  it("requires auth", async () => {
    await expectJson(await callRoute(getInstances), 401);
  });

  it("returns Sonarr and Radarr instances tagged with service type", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    await createTestSonarrInstance(user.id, { name: "S1" });
    await createTestRadarrInstance(user.id, { name: "R1" });

    const body = await expectJson<{ instances: { serviceType: string; name: string }[] }>(
      await callRoute(getInstances),
    );
    const types = body.instances.map((i) => i.serviceType).sort();
    expect(types).toEqual(["RADARR", "SONARR"]);
  });
});

describe("GET /api/tools/trash/catalog", () => {
  it("rejects an invalid service", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    await expectJson(await callRoute(getCatalog, { searchParams: { service: "plex" } }), 400);
  });

  it("returns catalog counts and naming", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    const body = await expectJson<{
      catalog: {
        counts: { customFormats: number };
        naming: unknown;
        categories: { name: string; trashIds: string[] }[];
        customFormats: { trashId: string; defaultScore: number }[];
        scoreSets: string[];
      };
    }>(await callRoute(getCatalog, { searchParams: { service: "radarr" } }));
    expect(body.catalog.counts.customFormats).toBe(1);
    expect(body.catalog.naming).not.toBeNull();
    // cf-groups become drill-down categories keyed by their [Bracket] prefix.
    expect(body.catalog.categories[0].name).toBe("Audio");
    expect(body.catalog.categories[0].trashIds).toEqual(["cf1"]);
    expect(body.catalog.customFormats[0]).toMatchObject({ trashId: "cf1", defaultScore: 100 });
    // Named score sets (excluding `default`) are exposed for the profile options UI.
    expect(body.catalog.scoreSets).toEqual(["sqp-1-2160p"]);
  });
});

describe("GET /api/tools/trash/status", () => {
  it("404s for an unknown instance", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    await expectJson(
      await callRoute(getStatus, { searchParams: { serviceType: "RADARR", instanceId: "nope" } }),
      404,
    );
  });

  it("classifies items: new / unmanaged / managed", async () => {
    const { user, radarr } = await authedUserWithRadarr();
    // The AMZN custom format exists in the Arr and is managed by Librariarr.
    // A matching lastSyncHash marks it genuinely in-sync with the guide, so it
    // classifies as MANAGED (a managed row with no lastSyncHash — an untaken-over
    // resource never synced — is MANAGED_OUTDATED instead).
    clientMock.getCustomFormats.mockResolvedValue([{ id: 55, name: "AMZN", specifications: [] }]);
    await getTestPrisma().trashManagedResource.create({
      data: {
        userId: user.id, serviceType: "RADARR", radarrInstanceId: radarr.id,
        resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN",
        lastSyncHash: trashCfHash(CATALOG.customFormats[0] as TrashCustomFormat),
      },
    });

    const body = await expectJson<{ status: { reachable: boolean; items: { resourceType: string; status: string }[] } }>(
      await callRoute(getStatus, { searchParams: { serviceType: "RADARR", instanceId: radarr.id } }),
    );
    expect(body.status.reachable).toBe(true);
    const cf = body.status.items.find((i) => i.resourceType === "CUSTOM_FORMAT");
    const qd = body.status.items.find((i) => i.resourceType === "QUALITY_DEFINITION");
    expect(cf?.status).toBe("MANAGED");
    // Quality definitions always exist → unmanaged conflict until assigned.
    expect(qd?.status).toBe("UNMANAGED_CONFLICT");
  });

  it("counts PROFILE_CF assignments in managedProfileCf (they aren't in items)", async () => {
    const { user, radarr } = await authedUserWithRadarr();
    await getTestPrisma().trashManagedResource.create({
      data: {
        userId: user.id, serviceType: "RADARR", radarrInstanceId: radarr.id,
        resourceType: "PROFILE_CF", trashId: "My Profile", name: "My Profile",
        selection: { formats: [{ trashId: "cf1", name: "AMZN", score: 500 }] },
      },
    });
    const body = await expectJson<{ status: { managedProfileCf: number; items: { resourceType: string }[] } }>(
      await callRoute(getStatus, { searchParams: { serviceType: "RADARR", instanceId: radarr.id } }),
    );
    // Counted as managed, but not surfaced as a status item (lives in its own tab).
    expect(body.status.managedProfileCf).toBe(1);
    expect(body.status.items.some((i) => i.resourceType === "PROFILE_CF")).toBe(false);
  });

  it("reports unreachable instances without throwing", async () => {
    const { radarr } = await authedUserWithRadarr();
    clientMock.getCustomFormats.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const body = await expectJson<{ status: { reachable: boolean } }>(
      await callRoute(getStatus, { searchParams: { serviceType: "RADARR", instanceId: radarr.id } }),
    );
    expect(body.status.reachable).toBe(false);
  });
});

describe("POST /api/tools/trash/assignments", () => {
  it("404s for an instance the user doesn't own", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    const res = await callRoute(postAssignment, {
      method: "POST",
      body: { serviceType: "RADARR", instanceId: "nope", items: [{ resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN" }] },
    });
    await expectJson(res, 404);
  });

  it("creates managed rows (the consent gate) without touching the Arr", async () => {
    const { radarr } = await authedUserWithRadarr();
    const res = await callRoute(postAssignment, {
      method: "POST",
      body: { serviceType: "RADARR", instanceId: radarr.id, items: [{ resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN" }] },
    });
    const body = await expectJson<{ assignments: unknown[] }>(res, 201);
    expect(body.assignments).toHaveLength(1);
    expect(clientMock.createCustomFormat).not.toHaveBeenCalled();

    const rows = await getTestPrisma().trashManagedResource.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].radarrInstanceId).toBe(radarr.id);
  });

  it("re-assigning updates rather than duplicating", async () => {
    const { radarr } = await authedUserWithRadarr();
    const body = { serviceType: "RADARR", instanceId: radarr.id, items: [{ resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN" }] };
    await callRoute(postAssignment, { method: "POST", body });
    await callRoute(postAssignment, { method: "POST", body });
    const rows = await getTestPrisma().trashManagedResource.findMany();
    expect(rows).toHaveLength(1);
  });

  it("rejects a Sonarr custom format assigned to a Radarr instance (cross-service gate)", async () => {
    const { radarr } = await authedUserWithRadarr();
    const res = await callRoute(postAssignment, {
      method: "POST",
      // "scf1" is a Sonarr-only trash_id; not in the Radarr catalog.
      body: { serviceType: "RADARR", instanceId: radarr.id, items: [{ resourceType: "CUSTOM_FORMAT", trashId: "scf1", name: "Sonarr CF" }] },
    });
    await expectJson(res, 400);
    expect(await getTestPrisma().trashManagedResource.count()).toBe(0);
  });

  it("rejects a Radarr custom format assigned to a Sonarr instance (cross-service gate)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    const sonarr = await createTestSonarrInstance(user.id);
    const res = await callRoute(postAssignment, {
      method: "POST",
      // "cf1" is a Radarr-only trash_id; not in the Sonarr catalog.
      body: { serviceType: "SONARR", instanceId: sonarr.id, items: [{ resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN" }] },
    });
    await expectJson(res, 400);
    expect(await getTestPrisma().trashManagedResource.count()).toBe(0);
  });

  it("lists assignments for an instance", async () => {
    const { radarr } = await authedUserWithRadarr();
    await callRoute(postAssignment, {
      method: "POST",
      body: { serviceType: "RADARR", instanceId: radarr.id, items: [{ resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN" }] },
    });
    const body = await expectJson<{ assignments: unknown[] }>(
      await callRoute(getAssignments, { searchParams: { serviceType: "RADARR", instanceId: radarr.id } }),
    );
    expect(body.assignments).toHaveLength(1);
  });
});

describe("assignments/[id]", () => {
  async function assignOne(radarrId: string) {
    const res = await callRoute(postAssignment, {
      method: "POST",
      body: { serviceType: "RADARR", instanceId: radarrId, items: [{ resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN" }] },
    });
    const { assignments } = await expectJson<{ assignments: { id: string }[] }>(res, 201);
    return assignments[0].id;
  }

  it("deletes a managed row (Arr resource untouched)", async () => {
    const { radarr } = await authedUserWithRadarr();
    const id = await assignOne(radarr.id);
    await expectJson(await callRouteWithParams(deleteAssignment, { id }, { method: "DELETE" }), 200);
    expect(await getTestPrisma().trashManagedResource.count()).toBe(0);
  });

  it("updates the naming selection", async () => {
    const { user, radarr } = await authedUserWithRadarr();
    const row = await getTestPrisma().trashManagedResource.create({
      data: { userId: user.id, serviceType: "RADARR", radarrInstanceId: radarr.id, resourceType: "NAMING", trashId: "naming", name: "Naming" },
    });
    const res = await callRouteWithParams(putAssignment, { id: row.id }, {
      method: "PUT",
      body: { selection: { file: "standard", folder: "default" } },
    });
    await expectJson(res, 200);
    const updated = await getTestPrisma().trashManagedResource.findUnique({ where: { id: row.id } });
    expect((updated?.selection as { file?: string })?.file).toBe("standard");
  });

  it("404s when deleting another user's row", async () => {
    const other = await createTestUser({ username: "other", plexId: "p2" });
    const otherRadarr = await createTestRadarrInstance(other.id);
    const row = await getTestPrisma().trashManagedResource.create({
      data: { userId: other.id, serviceType: "RADARR", radarrInstanceId: otherRadarr.id, resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN" },
    });
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    await expectJson(await callRouteWithParams(deleteAssignment, { id: row.id }, { method: "DELETE" }), 404);
  });
});

describe("POST /api/tools/trash/sync", () => {
  it("dry-run previews changes without writing to the Arr or DB", async () => {
    const { radarr } = await authedUserWithRadarr();
    const res = await callRoute(postSync, {
      method: "POST",
      body: {
        serviceType: "RADARR",
        instanceId: radarr.id,
        dryRun: true,
        items: [{ resourceType: "CUSTOM_FORMAT", trashId: "cf1" }],
      },
    });
    const body = await expectJson<{ report: { dryRun: boolean; items: { action: string; diff: unknown[] }[] } }>(res);
    expect(body.report.dryRun).toBe(true);
    expect(body.report.items[0].action).toBe("CREATE");
    expect(body.report.items[0].diff.length).toBeGreaterThan(0);
    expect(clientMock.createCustomFormat).not.toHaveBeenCalled();
  });

  it("apply writes only managed resources and records the result", async () => {
    const { user, radarr } = await authedUserWithRadarr();
    await getTestPrisma().trashManagedResource.create({
      data: { userId: user.id, serviceType: "RADARR", radarrInstanceId: radarr.id, resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN" },
    });

    const res = await callRoute(postSync, {
      method: "POST",
      body: { serviceType: "RADARR", instanceId: radarr.id, dryRun: false },
    });
    const body = await expectJson<{ report: { items: { action: string; applied?: boolean }[] } }>(res);
    expect(body.report.items[0].action).toBe("CREATE");
    expect(clientMock.createCustomFormat).toHaveBeenCalledTimes(1);

    const row = await getTestPrisma().trashManagedResource.findFirst();
    expect(row?.arrId).toBe(500);
    expect(row?.lastSyncedAt).not.toBeNull();
  });

  it("apply with items syncs only that managed resource, leaving others untouched", async () => {
    const { user, radarr } = await authedUserWithRadarr();
    await getTestPrisma().trashManagedResource.createMany({
      data: [
        { userId: user.id, serviceType: "RADARR", radarrInstanceId: radarr.id, resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN" },
        { userId: user.id, serviceType: "RADARR", radarrInstanceId: radarr.id, resourceType: "QUALITY_DEFINITION", trashId: "qs1", name: "Sizes" },
      ],
    });

    const res = await callRoute(postSync, {
      method: "POST",
      body: {
        serviceType: "RADARR",
        instanceId: radarr.id,
        dryRun: false,
        items: [{ resourceType: "CUSTOM_FORMAT", trashId: "cf1" }],
      },
    });
    const body = await expectJson<{ report: { items: { resourceType: string }[] } }>(res);
    // Only the custom format was in scope.
    expect(body.report.items).toHaveLength(1);
    expect(body.report.items[0].resourceType).toBe("CUSTOM_FORMAT");
    expect(clientMock.createCustomFormat).toHaveBeenCalledTimes(1);
    expect(clientMock.updateQualityDefinitions).not.toHaveBeenCalled();

    // The quality-definition row was left unsynced.
    const qdRow = await getTestPrisma().trashManagedResource.findFirst({ where: { resourceType: "QUALITY_DEFINITION" } });
    expect(qdRow?.lastSyncedAt).toBeNull();
  });

  it("quality-profile sync preserves custom-format scores it doesn't manage", async () => {
    const { user, radarr } = await authedUserWithRadarr();
    // The instance profile already scores a CF the guide profile never references.
    clientMock.getQualityProfiles.mockResolvedValue([
      {
        id: 3,
        name: "HD Bluray + WEB",
        cutoff: 7,
        upgradeAllowed: true,
        minFormatScore: 0,
        cutoffFormatScore: 0,
        items: [{ quality: { id: 7, name: "Bluray-1080p" }, items: [], allowed: true }],
        formatItems: [
          { format: 55, name: "AMZN", score: 0 },
          { format: 77, name: "My CF", score: 500 },
        ],
      },
    ]);
    clientMock.getQualityProfileSchema.mockResolvedValue({
      ...SCHEMA,
      formatItems: [
        { format: 55, name: "AMZN", score: 0 },
        { format: 77, name: "My CF", score: 0 },
      ],
    });
    await getTestPrisma().trashManagedResource.create({
      data: {
        userId: user.id, serviceType: "RADARR", radarrInstanceId: radarr.id,
        resourceType: "QUALITY_PROFILE", trashId: "qp1", name: "HD Bluray + WEB",
      },
    });
    const res = await callRoute(postSync, {
      method: "POST",
      body: { serviceType: "RADARR", instanceId: radarr.id, dryRun: false, items: [{ resourceType: "QUALITY_PROFILE", trashId: "qp1" }] },
    });
    await expectJson(res, 200);
    expect(clientMock.updateQualityProfile).toHaveBeenCalledTimes(1);
    const [, payload] = clientMock.updateQualityProfile.mock.calls[0] as [number, { formatItems: { name: string; score: number }[] }];
    // The guide CF is set to its guide score; the unmanaged CF keeps its score.
    expect(payload.formatItems.find((f) => f.name === "AMZN")?.score).toBe(100);
    expect(payload.formatItems.find((f) => f.name === "My CF")?.score).toBe(500);
  });

  it("quality-profile sync resets unmatched scores when the option is enabled", async () => {
    const { user, radarr } = await authedUserWithRadarr();
    clientMock.getQualityProfiles.mockResolvedValue([
      {
        id: 3,
        name: "HD Bluray + WEB",
        cutoff: 7,
        upgradeAllowed: true,
        minFormatScore: 0,
        cutoffFormatScore: 0,
        items: [{ quality: { id: 7, name: "Bluray-1080p" }, items: [], allowed: true }],
        formatItems: [
          { format: 55, name: "AMZN", score: 0 },
          { format: 77, name: "My CF", score: 500 },
        ],
      },
    ]);
    clientMock.getQualityProfileSchema.mockResolvedValue({
      ...SCHEMA,
      formatItems: [
        { format: 55, name: "AMZN", score: 0 },
        { format: 77, name: "My CF", score: 0 },
      ],
    });
    await getTestPrisma().trashManagedResource.create({
      data: {
        userId: user.id, serviceType: "RADARR", radarrInstanceId: radarr.id,
        resourceType: "QUALITY_PROFILE", trashId: "qp1", name: "HD Bluray + WEB",
        // Opt into resetting unmatched scores.
        selection: { resetUnmatchedScores: true },
      },
    });
    const res = await callRoute(postSync, {
      method: "POST",
      body: { serviceType: "RADARR", instanceId: radarr.id, dryRun: false, items: [{ resourceType: "QUALITY_PROFILE", trashId: "qp1" }] },
    });
    await expectJson(res, 200);
    const [, payload] = clientMock.updateQualityProfile.mock.calls[0] as [number, { formatItems: { name: string; score: number }[] }];
    // Guide CF still scored; the unmanaged CF is reset to 0.
    expect(payload.formatItems.find((f) => f.name === "AMZN")?.score).toBe(100);
    expect(payload.formatItems.find((f) => f.name === "My CF")?.score).toBe(0);
  });

  it("quality-profile sync honors a per-profile score set override", async () => {
    const { user, radarr } = await authedUserWithRadarr();
    clientMock.getQualityProfiles.mockResolvedValue([
      {
        id: 3,
        name: "HD Bluray + WEB",
        cutoff: 7,
        upgradeAllowed: true,
        minFormatScore: 0,
        cutoffFormatScore: 0,
        items: [{ quality: { id: 7, name: "Bluray-1080p" }, items: [], allowed: true }],
        formatItems: [{ format: 55, name: "AMZN", score: 0 }],
      },
    ]);
    await getTestPrisma().trashManagedResource.create({
      data: {
        userId: user.id, serviceType: "RADARR", radarrInstanceId: radarr.id,
        resourceType: "QUALITY_PROFILE", trashId: "qp1", name: "HD Bluray + WEB",
        selection: { scoreSet: "sqp-1-2160p" },
      },
    });
    const res = await callRoute(postSync, {
      method: "POST",
      body: { serviceType: "RADARR", instanceId: radarr.id, dryRun: false, items: [{ resourceType: "QUALITY_PROFILE", trashId: "qp1" }] },
    });
    await expectJson(res, 200);
    const [, payload] = clientMock.updateQualityProfile.mock.calls[0] as [number, { formatItems: { name: string; score: number }[] }];
    // AMZN's score comes from the sqp-1-2160p set (-25), not default (100).
    expect(payload.formatItems.find((f) => f.name === "AMZN")?.score).toBe(-25);
  });

  it("PUT stores quality-profile options (score set + reset) on the managed row", async () => {
    const { user, radarr } = await authedUserWithRadarr();
    const row = await getTestPrisma().trashManagedResource.create({
      data: {
        userId: user.id, serviceType: "RADARR", radarrInstanceId: radarr.id,
        resourceType: "QUALITY_PROFILE", trashId: "qp1", name: "HD Bluray + WEB",
      },
    });
    const res = await callRouteWithParams(putAssignment, { id: row.id }, {
      method: "PUT",
      body: { selection: { scoreSet: "sqp-1-2160p", resetUnmatchedScores: true, resetExcept: ["Keep Me"], resetExceptPatterns: ["^anime"] } },
    });
    await expectJson(res, 200);
    const updated = await getTestPrisma().trashManagedResource.findUnique({ where: { id: row.id } });
    const sel = updated?.selection as {
      scoreSet?: string;
      resetUnmatchedScores?: boolean;
      resetExcept?: string[];
      resetExceptPatterns?: string[];
    };
    expect(sel.scoreSet).toBe("sqp-1-2160p");
    expect(sel.resetUnmatchedScores).toBe(true);
    expect(sel.resetExcept).toEqual(["Keep Me"]);
    expect(sel.resetExceptPatterns).toEqual(["^anime"]);
  });

  it("PUT rejects an invalid except regex pattern", async () => {
    const { user, radarr } = await authedUserWithRadarr();
    const row = await getTestPrisma().trashManagedResource.create({
      data: {
        userId: user.id, serviceType: "RADARR", radarrInstanceId: radarr.id,
        resourceType: "QUALITY_PROFILE", trashId: "qp1", name: "HD Bluray + WEB",
      },
    });
    const res = await callRouteWithParams(putAssignment, { id: row.id }, {
      method: "PUT",
      body: { selection: { resetUnmatchedScores: true, resetExceptPatterns: ["("] } },
    });
    await expectJson(res, 400);
  });

  it("apply ignores unmanaged preview items (nothing written without a managed row)", async () => {
    const { radarr } = await authedUserWithRadarr();
    // No managed rows; passing items with dryRun:false must not write anything.
    const res = await callRoute(postSync, {
      method: "POST",
      body: {
        serviceType: "RADARR",
        instanceId: radarr.id,
        dryRun: false,
        items: [{ resourceType: "CUSTOM_FORMAT", trashId: "cf1" }],
      },
    });
    const body = await expectJson<{ report: { items: unknown[] } }>(res);
    expect(body.report.items).toHaveLength(0);
    expect(clientMock.createCustomFormat).not.toHaveBeenCalled();
  });
});

describe("Profile custom formats (PROFILE_CF)", () => {
  it("GET /profiles lists quality profiles with their non-zero scores and the instance's format names", async () => {
    const { radarr } = await authedUserWithRadarr();
    clientMock.getQualityProfiles.mockResolvedValue([
      { id: 9, name: "My Profile", formatItems: [{ format: 55, name: "AMZN", score: 200 }, { format: 56, name: "X", score: 0 }] },
      { id: 10, name: "Other", formatItems: [{ format: 55, name: "AMZN", score: 0 }, { format: 57, name: "DV", score: 0 }] },
    ]);
    const body = await expectJson<{
      profiles: { name: string; formatScores: Record<string, number> }[];
      instanceFormatNames: string[];
    }>(await callRoute(getProfiles, { searchParams: { serviceType: "RADARR", instanceId: radarr.id } }));
    expect(body.profiles[0].name).toBe("My Profile");
    expect(body.profiles[0].formatScores).toEqual({ AMZN: 200 });
    // Union of every custom-format name present across the instance's profiles,
    // sorted — used by the UI to flag an assigned format that isn't in the app.
    expect(body.instanceFormatNames).toEqual(["AMZN", "DV", "X"]);
  });

  it("assigns PROFILE_CF when the attached custom formats are in the guide", async () => {
    const { radarr } = await authedUserWithRadarr();
    const res = await callRoute(postAssignment, {
      method: "POST",
      body: {
        serviceType: "RADARR",
        instanceId: radarr.id,
        items: [
          { resourceType: "PROFILE_CF", trashId: "My Profile", name: "My Profile", selection: { formats: [{ trashId: "cf1", name: "AMZN", score: 500 }] } },
        ],
      },
    });
    await expectJson(res, 201);
    const row = await getTestPrisma().trashManagedResource.findFirst({ where: { resourceType: "PROFILE_CF" } });
    expect(row?.trashId).toBe("My Profile");
  });

  it("rejects PROFILE_CF whose attached custom format isn't in the guide", async () => {
    const { radarr } = await authedUserWithRadarr();
    const res = await callRoute(postAssignment, {
      method: "POST",
      body: {
        serviceType: "RADARR",
        instanceId: radarr.id,
        items: [
          { resourceType: "PROFILE_CF", trashId: "My Profile", name: "My Profile", selection: { formats: [{ trashId: "not-in-guide", name: "Nope", score: 10 }] } },
        ],
      },
    });
    await expectJson(res, 400);
    expect(await getTestPrisma().trashManagedResource.count()).toBe(0);
  });

  it("sync overlays the assigned scores onto the profile, preserving others", async () => {
    const { user, radarr } = await authedUserWithRadarr();
    clientMock.getQualityProfiles.mockResolvedValue([
      { id: 9, name: "My Profile", formatItems: [{ format: 55, name: "AMZN", score: 0 }, { format: 56, name: "Other", score: 100 }] },
    ]);
    await getTestPrisma().trashManagedResource.create({
      data: {
        userId: user.id, serviceType: "RADARR", radarrInstanceId: radarr.id,
        resourceType: "PROFILE_CF", trashId: "My Profile", name: "My Profile",
        selection: { formats: [{ trashId: "cf1", name: "AMZN", score: 500 }] },
      },
    });
    const res = await callRoute(postSync, {
      method: "POST",
      body: { serviceType: "RADARR", instanceId: radarr.id, dryRun: false, items: [{ resourceType: "PROFILE_CF", trashId: "My Profile" }] },
    });
    const body = await expectJson<{ report: { items: { action: string }[] } }>(res);
    expect(body.report.items[0].action).toBe("UPDATE");
    expect(clientMock.updateQualityProfile).toHaveBeenCalledTimes(1);
    const [id, payload] = clientMock.updateQualityProfile.mock.calls[0] as [number, { formatItems: { name: string; score: number }[] }];
    expect(id).toBe(9);
    expect(payload.formatItems.find((f) => f.name === "AMZN")?.score).toBe(500);
    expect(payload.formatItems.find((f) => f.name === "Other")?.score).toBe(100);
  });
});
