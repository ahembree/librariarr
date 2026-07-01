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
      trash_scores: { default: 100 },
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
    const body = await expectJson<{ catalog: { counts: { customFormats: number }; naming: unknown } }>(
      await callRoute(getCatalog, { searchParams: { service: "radarr" } }),
    );
    expect(body.catalog.counts.customFormats).toBe(1);
    expect(body.catalog.naming).not.toBeNull();
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
    clientMock.getCustomFormats.mockResolvedValue([{ id: 55, name: "AMZN", specifications: [] }]);
    await getTestPrisma().trashManagedResource.create({
      data: { userId: user.id, serviceType: "RADARR", radarrInstanceId: radarr.id, resourceType: "CUSTOM_FORMAT", trashId: "cf1", name: "AMZN" },
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
