import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
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
const mockGetCollections = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockGetCollectionVisibility = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ home: true, recommended: false })
);

vi.mock("@/lib/plex/client", () => ({
  PlexClient: vi.fn().mockImplementation(function () {
    return {
      getCollections: mockGetCollections,
      getCollectionVisibility: mockGetCollectionVisibility,
    };
  }),
}));

// Import AFTER mocks
import { GET } from "@/app/api/lifecycle/collections/visibility/route";

describe("GET /api/lifecycle/collections/visibility", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockGetCollections.mockResolvedValue([]);
    mockGetCollectionVisibility.mockResolvedValue({ home: true, recommended: false });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const response = await callRoute(GET, {
      url: "/api/lifecycle/collections/visibility",
      searchParams: { ruleSetId: "some-id" },
    });
    await expectJson(response, 401);
  });

  it("returns 400 when ruleSetId is missing", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, {
      url: "/api/lifecycle/collections/visibility",
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toContain("ruleSetId");
  });

  it("returns false/false for non-existent rule set", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, {
      url: "/api/lifecycle/collections/visibility",
      searchParams: { ruleSetId: "nonexistent" },
    });

    const body = await expectJson<{ home: boolean; recommended: boolean }>(response, 200);
    expect(body.home).toBe(false);
    expect(body.recommended).toBe(false);
  });

  it("returns false/false when rule set has no collection name", async () => {
    const user = await createTestUser();
    const ruleSet = await createTestRuleSet(user.id, {
      name: "No Collection",
      collectionEnabled: false,
    });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, {
      url: "/api/lifecycle/collections/visibility",
      searchParams: { ruleSetId: ruleSet.id },
    });

    const body = await expectJson<{ home: boolean; recommended: boolean }>(response, 200);
    expect(body.home).toBe(false);
    expect(body.recommended).toBe(false);
  });

  it("returns false/false when collection not found on any Plex server", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { type: "MOVIE" });
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Test",
      collectionEnabled: true,
      collectionName: "My Collection",
    });

    mockGetCollections.mockResolvedValue([]);

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, {
      url: "/api/lifecycle/collections/visibility",
      searchParams: { ruleSetId: ruleSet.id },
    });

    const body = await expectJson<{ home: boolean; recommended: boolean }>(response, 200);
    expect(body.home).toBe(false);
    expect(body.recommended).toBe(false);
  });

  it("returns visibility from Plex when collection exists", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { type: "MOVIE" });
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Visible",
      collectionEnabled: true,
      collectionName: "Visible Collection",
    });

    mockGetCollections.mockResolvedValue([
      { title: "Visible Collection", ratingKey: "123" },
    ]);
    mockGetCollectionVisibility.mockResolvedValue({
      home: true,
      recommended: true,
    });

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, {
      url: "/api/lifecycle/collections/visibility",
      searchParams: { ruleSetId: ruleSet.id },
    });

    const body = await expectJson<{ home: boolean; recommended: boolean }>(response, 200);
    expect(body.home).toBe(true);
    expect(body.recommended).toBe(true);
  });

  it("returns false/false for another user's rule set", async () => {
    const user1 = await createTestUser({ plexId: "owner" });
    const user2 = await createTestUser({ plexId: "viewer" });
    const ruleSet = await createTestRuleSet(user1.id, {
      name: "Private",
      collectionEnabled: true,
      collectionName: "Private Collection",
    });

    setMockSession({ isLoggedIn: true, userId: user2.id });

    const response = await callRoute(GET, {
      url: "/api/lifecycle/collections/visibility",
      searchParams: { ruleSetId: ruleSet.id },
    });

    const body = await expectJson<{ home: boolean; recommended: boolean }>(response, 200);
    expect(body.home).toBe(false);
    expect(body.recommended).toBe(false);
  });

  it("handles Plex client errors gracefully", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { type: "MOVIE" });
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Error",
      collectionEnabled: true,
      collectionName: "Error Collection",
    });

    mockGetCollections.mockRejectedValue(new Error("Connection refused"));

    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, {
      url: "/api/lifecycle/collections/visibility",
      searchParams: { ruleSetId: ruleSet.id },
    });

    const body = await expectJson<{ home: boolean; recommended: boolean }>(response, 200);
    expect(body.home).toBe(false);
    expect(body.recommended).toBe(false);
  });
});
