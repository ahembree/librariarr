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

  it("cleans up matches and pending actions when rule set loses all servers (deleteData=false)", async () => {
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

    // Create a completed action (should be preserved — only PENDING actions are cleaned)
    const completedAction = await prisma.lifecycleAction.create({
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

    // deleteData=false: items preserved, but server removed
    const response = await callRouteWithParams(
      DELETE,
      { id: server.id },
      { url: `/api/servers/${server.id}`, method: "DELETE" }
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

    // Completed action should be preserved
    const preserved = await prisma.lifecycleAction.findUnique({
      where: { id: completedAction.id },
    });
    expect(preserved).not.toBeNull();
    expect(preserved!.status).toBe("COMPLETED");
  });

  it("cleans up with deleteData=true via cascade and explicit deletes", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id);
    const item = await createTestMediaItem(library.id);

    const ruleSet = await createTestRuleSet(user.id, {
      serverIds: [server.id],
      actionEnabled: true,
      actionType: "DELETE",
    });

    await prisma.ruleMatch.create({
      data: {
        ruleSetId: ruleSet.id,
        mediaItemId: item.id,
        itemData: {},
      },
    });

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

    // Matches cleaned (cascade from media item deletion)
    const matches = await prisma.ruleMatch.findMany({
      where: { ruleSetId: ruleSet.id },
    });
    expect(matches).toHaveLength(0);

    // Actions cleaned (explicit delete before media item deletion)
    const actions = await prisma.lifecycleAction.findMany({
      where: { ruleSetId: ruleSet.id },
    });
    expect(actions).toHaveLength(0);
  });

  it("cleans stale matches from deleted server but preserves other servers' matches", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id);
    const server2 = await createTestServer(user.id);
    const library1 = await createTestLibrary(server1.id);
    const library2 = await createTestLibrary(server2.id);
    const item1 = await createTestMediaItem(library1.id);
    const item2 = await createTestMediaItem(library2.id);

    const ruleSet = await createTestRuleSet(user.id, {
      serverIds: [server1.id, server2.id],
      actionEnabled: true,
      actionType: "DELETE",
    });

    // Match for item on server1 (should be cleaned)
    await prisma.ruleMatch.create({
      data: {
        ruleSetId: ruleSet.id,
        mediaItemId: item1.id,
        itemData: {},
      },
    });

    // Pending action for item on server1 (should be cleaned)
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id,
        mediaItemId: item1.id,
        ruleSetId: ruleSet.id,
        ruleSetName: ruleSet.name,
        actionType: "DELETE",
        status: "PENDING",
        scheduledFor: new Date(Date.now() + 86400000),
      },
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

    // Delete server1 WITHOUT deleteData — items preserved but server gone
    const response = await callRouteWithParams(
      DELETE,
      { id: server1.id },
      { url: `/api/servers/${server1.id}`, method: "DELETE" }
    );
    await expectJson(response, 200);

    // Rule set should still have server2
    const updated = await prisma.ruleSet.findUnique({
      where: { id: ruleSet.id },
    });
    expect(updated!.serverIds).toEqual([server2.id]);

    // Match for server1's item should be cleaned
    const matches = await prisma.ruleMatch.findMany({
      where: { ruleSetId: ruleSet.id },
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].mediaItemId).toBe(item2.id);

    // Pending action for server1's item should be cleaned
    const pendingActions = await prisma.lifecycleAction.findMany({
      where: { ruleSetId: ruleSet.id, status: "PENDING" },
    });
    expect(pendingActions).toHaveLength(0);
  });
});
