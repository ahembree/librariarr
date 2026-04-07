import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
} from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn().mockReturnValue({
    testConnection: vi.fn().mockResolvedValue({ ok: true, serverName: "Test" }),
  }),
}));

vi.mock("@/lib/cache/memory-cache", () => ({
  appCache: {
    get: vi.fn(),
    set: vi.fn(),
    invalidate: vi.fn(),
    invalidatePrefix: vi.fn(),
  },
}));

vi.mock("@/lib/dedup/recompute-canonical", () => ({
  recomputeCanonical: vi.fn(),
}));

// Import route handler AFTER mocks
import { DELETE } from "@/app/api/servers/[id]/route";

describe("DELETE /api/servers/[id] lifecycle cleanup", () => {
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("removes deleted server ID from rule set serverIds", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id);
    const server2 = await createTestServer(user.id);

    const ruleSet = await createTestRuleSet(user.id, {
      serverIds: [server1.id, server2.id],
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      DELETE,
      { id: server1.id },
      { url: `/api/servers/${server1.id}`, method: "DELETE" }
    );
    await expectJson(response, 200);

    const updated = await prisma.ruleSet.findUnique({
      where: { id: ruleSet.id },
    });
    expect(updated!.serverIds).toEqual([server2.id]);
  });

  it("cleans up matches and pending actions when rule set loses all servers", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id);
    const item = await createTestMediaItem(library.id);

    const ruleSet = await createTestRuleSet(user.id, {
      serverIds: [server.id],
      actionEnabled: true,
      actionType: "DELETE",
    });

    // Create a rule match
    await prisma.ruleMatch.create({
      data: {
        ruleSetId: ruleSet.id,
        mediaItemId: item.id,
        itemData: {},
      },
    });

    // Create a pending lifecycle action
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id,
        mediaItemId: item.id,
        ruleSetId: ruleSet.id,
        ruleSetName: ruleSet.name,
        actionType: "DELETE",
        status: "PENDING",
        scheduledFor: new Date(Date.now() + 86400000),
      },
    });

    // Create a completed action (should NOT be deleted)
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id,
        mediaItemId: item.id,
        ruleSetId: ruleSet.id,
        ruleSetName: ruleSet.name,
        actionType: "DELETE",
        status: "COMPLETED",
        scheduledFor: new Date(),
        executedAt: new Date(),
      },
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      DELETE,
      { id: server.id },
      { url: `/api/servers/${server.id}?deleteData=true`, method: "DELETE" }
    );
    await expectJson(response, 200);

    // Rule set should have empty serverIds
    const updated = await prisma.ruleSet.findUnique({
      where: { id: ruleSet.id },
    });
    expect(updated!.serverIds).toEqual([]);

    // All rule matches should be deleted
    const matches = await prisma.ruleMatch.findMany({
      where: { ruleSetId: ruleSet.id },
    });
    expect(matches).toHaveLength(0);

    // Pending actions should be deleted
    const pendingActions = await prisma.lifecycleAction.findMany({
      where: { ruleSetId: ruleSet.id, status: "PENDING" },
    });
    expect(pendingActions).toHaveLength(0);
  });

  it("preserves rule set serverIds for other servers", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id);
    const server2 = await createTestServer(user.id);
    const library2 = await createTestLibrary(server2.id);
    const item2 = await createTestMediaItem(library2.id);

    const ruleSet = await createTestRuleSet(user.id, {
      serverIds: [server1.id, server2.id],
    });

    // Match for item on server2 (should be preserved)
    await prisma.ruleMatch.create({
      data: {
        ruleSetId: ruleSet.id,
        mediaItemId: item2.id,
        itemData: {},
      },
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      DELETE,
      { id: server1.id },
      { url: `/api/servers/${server1.id}?deleteData=true`, method: "DELETE" }
    );
    await expectJson(response, 200);

    // Rule set should still have server2
    const updated = await prisma.ruleSet.findUnique({
      where: { id: ruleSet.id },
    });
    expect(updated!.serverIds).toEqual([server2.id]);

    // Match for server2's item should be preserved
    const matches = await prisma.ruleMatch.findMany({
      where: { ruleSetId: ruleSet.id },
    });
    expect(matches).toHaveLength(1);
  });
});
