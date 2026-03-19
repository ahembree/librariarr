import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestRuleSet,
} from "../../setup/test-helpers";

// Critical: redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

// Suppress logger DB writes
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock Plex client
vi.mock("@/lib/plex/client", () => ({
  PlexClient: vi.fn().mockImplementation(function () {
    return {
      getCollections: vi.fn().mockResolvedValue([]),
      renameCollection: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

// Mock removePlexCollection
const mockRemovePlexCollection = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/lifecycle/collections", () => ({
  removePlexCollection: mockRemovePlexCollection,
}));

vi.mock("@/lib/api/sanitize", () => ({
  sanitize: vi.fn().mockImplementation((v: unknown) => v),
  sanitizeErrorDetail: vi.fn().mockImplementation((msg: string) => msg),
}));

// Import AFTER mocks
import { POST } from "@/app/api/lifecycle/collections/apply/route";

describe("POST /api/lifecycle/collections/apply", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const response = await callRoute(POST, {
      url: "/api/lifecycle/collections/apply",
      method: "POST",
      body: { ruleSetId: "some-id" },
    });
    await expectJson(response, 401);
  });

  it("returns 400 for missing ruleSetId", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/collections/apply",
      method: "POST",
      body: {},
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Validation failed");
  });

  it("returns 404 for non-existent rule set", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/collections/apply",
      method: "POST",
      body: { ruleSetId: "nonexistent" },
    });
    await expectJson(response, 404);
  });

  it("returns 404 for another user's rule set", async () => {
    const user1 = await createTestUser({ plexId: "owner" });
    const user2 = await createTestUser({ plexId: "intruder" });
    const ruleSet = await createTestRuleSet(user1.id, { name: "Private" });

    setMockSession({ isLoggedIn: true, userId: user2.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/collections/apply",
      method: "POST",
      body: { ruleSetId: ruleSet.id },
    });
    await expectJson(response, 404);
  });

  it("returns success with no changes when collection not enabled", async () => {
    const user = await createTestUser();
    const ruleSet = await createTestRuleSet(user.id, {
      name: "No Collection",
      collectionEnabled: false,
    });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/collections/apply",
      method: "POST",
      body: { ruleSetId: ruleSet.id },
    });

    const body = await expectJson<{ success: boolean; changes: string[] }>(response, 200);
    expect(body.success).toBe(true);
    expect(body.changes).toHaveLength(0);
  });

  it("removes collection when collection was disabled", async () => {
    const user = await createTestUser();
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Disabled Collection",
      collectionEnabled: false,
    });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/collections/apply",
      method: "POST",
      body: {
        ruleSetId: ruleSet.id,
        previousCollectionEnabled: true,
        previousCollectionName: "Old Collection",
      },
    });

    const body = await expectJson<{ success: boolean; changes: string[] }>(response, 200);
    expect(body.success).toBe(true);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toContain("Removed");
    expect(mockRemovePlexCollection).toHaveBeenCalledWith(
      user.id,
      "MOVIE",
      "Old Collection"
    );
  });

  it("keeps collection when skipCollectionRemoval is true", async () => {
    const user = await createTestUser();
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Keep Collection",
      collectionEnabled: false,
    });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/collections/apply",
      method: "POST",
      body: {
        ruleSetId: ruleSet.id,
        previousCollectionEnabled: true,
        previousCollectionName: "Kept Collection",
        skipCollectionRemoval: true,
      },
    });

    const body = await expectJson<{ success: boolean; changes: string[] }>(response, 200);
    expect(body.success).toBe(true);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toContain("kept");
    expect(mockRemovePlexCollection).not.toHaveBeenCalled();
  });

  it("returns success with no changes when collection enabled but no name", async () => {
    const user = await createTestUser();
    const ruleSet = await createTestRuleSet(user.id, {
      name: "No Name",
      collectionEnabled: true,
      collectionName: undefined as unknown as string,
    });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/collections/apply",
      method: "POST",
      body: { ruleSetId: ruleSet.id },
    });

    const body = await expectJson<{ success: boolean; changes: string[] }>(response, 200);
    expect(body.success).toBe(true);
    expect(body.changes).toHaveLength(0);
  });
});
