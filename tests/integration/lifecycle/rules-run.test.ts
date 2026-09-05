import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser, createTestRuleSet, createTestServer } from "../../setup/test-helpers";

// Mock the lifecycle processor
const mockRunDetection = vi.hoisted(() => vi.fn());
const mockScheduleActionsForRuleSet = vi.hoisted(() => vi.fn());
const mockSyncCollectionsAfterDetection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lifecycle/detect-matches", () => ({
  runDetection: mockRunDetection,
  syncCollectionsAfterDetection: mockSyncCollectionsAfterDetection,
}));
vi.mock("@/lib/lifecycle/processor", () => ({
  scheduleActionsForRuleSet: mockScheduleActionsForRuleSet,
}));

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

// Import route handler AFTER mocks
import { POST } from "@/app/api/lifecycle/rules/run/route";

describe("POST /api/lifecycle/rules/run", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/run",
      method: "POST",
      body: {},
    });
    await expectJson(response, 401);
  });

  it("returns 400 on invalid body (non-JSON)", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/run",
      method: "POST",
      // No body triggers "Invalid JSON in request body"
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Invalid JSON in request body");
  });

  it("calls runDetection with correct params for specific ruleSetId", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const mockResult = [{ ruleSetId: "rs-1", matchCount: 5 }];
    mockRunDetection.mockResolvedValue(mockResult);

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/run",
      method: "POST",
      body: { ruleSetId: "rs-1" },
    });
    const body = await expectJson<{ ruleMatches: unknown[] }>(response, 200);

    expect(mockRunDetection).toHaveBeenCalledWith(user.id, "rs-1", false);
    expect(body.ruleMatches).toEqual(mockResult);
  });

  it("calls runDetection with fullReEval when specified", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    mockRunDetection.mockResolvedValue([]);

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/run",
      method: "POST",
      body: { ruleSetId: "rs-1", fullReEval: true },
    });
    await expectJson(response, 200);

    expect(mockRunDetection).toHaveBeenCalledWith(user.id, "rs-1", true);
  });

  it("calls runDetection with undefined ruleSetId when not specified", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    mockRunDetection.mockResolvedValue([]);

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/run",
      method: "POST",
      body: {},
    });
    const body = await expectJson<{ ruleMatches: unknown[] }>(response, 200);
    expect(body.ruleMatches).toEqual([]);

    expect(mockRunDetection).toHaveBeenCalledWith(user.id, undefined, false);
  });

  it("schedules actions for a specific rule set when processActions is true", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const ruleSet = await createTestRuleSet(user.id, {
      actionEnabled: true,
      actionType: "DELETE_RADARR",
    });

    mockRunDetection.mockResolvedValue([
      {
        ruleSet: { id: ruleSet.id, name: ruleSet.name },
        items: [{ id: "item1", title: "Movie 1" }],
        count: 1,
      },
    ]);
    mockScheduleActionsForRuleSet.mockResolvedValue(undefined);

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/run",
      method: "POST",
      body: { ruleSetId: ruleSet.id, processActions: true },
    });
    await expectJson(response, 200);

    expect(mockScheduleActionsForRuleSet).toHaveBeenCalledTimes(1);
    expect(mockScheduleActionsForRuleSet).toHaveBeenCalledWith(
      expect.objectContaining({ id: ruleSet.id }),
      expect.arrayContaining([expect.objectContaining({ id: "item1" })]),
      expect.any(Map),
    );
  });

  it("schedules actions for all rule sets when processActions is true without ruleSetId", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const ruleSet1 = await createTestRuleSet(user.id, {
      name: "Rule 1",
      actionEnabled: true,
      actionType: "DELETE_RADARR",
    });
    const ruleSet2 = await createTestRuleSet(user.id, {
      name: "Rule 2",
      actionEnabled: true,
      actionType: "UNMONITOR_RADARR",
    });

    mockRunDetection.mockResolvedValue([
      {
        ruleSet: { id: ruleSet1.id, name: "Rule 1" },
        items: [{ id: "item1", title: "Movie 1" }],
        count: 1,
      },
      {
        ruleSet: { id: ruleSet2.id, name: "Rule 2" },
        items: [{ id: "item2", title: "Movie 2" }],
        count: 1,
      },
    ]);
    mockScheduleActionsForRuleSet.mockResolvedValue(undefined);

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/run",
      method: "POST",
      body: { fullReEval: true, processActions: true },
    });
    await expectJson(response, 200);

    expect(mockScheduleActionsForRuleSet).toHaveBeenCalledTimes(2);
    expect(mockScheduleActionsForRuleSet).toHaveBeenCalledWith(
      expect.objectContaining({ id: ruleSet1.id }),
      expect.arrayContaining([expect.objectContaining({ id: "item1" })]),
      expect.any(Map),
    );
    expect(mockScheduleActionsForRuleSet).toHaveBeenCalledWith(
      expect.objectContaining({ id: ruleSet2.id }),
      expect.arrayContaining([expect.objectContaining({ id: "item2" })]),
      expect.any(Map),
    );
  });

  it("does not schedule actions when processActions is false", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });

    mockRunDetection.mockResolvedValue([
      {
        ruleSet: { id: "rs1", name: "Rule 1" },
        items: [{ id: "item1", title: "Movie 1" }],
        count: 1,
      },
    ]);

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules/run",
      method: "POST",
      body: { ruleSetId: "rs1" },
    });
    await expectJson(response, 200);

    expect(mockScheduleActionsForRuleSet).not.toHaveBeenCalled();
  });
  // `runDetection` skips a rule set silently (it logs a warning and moves on),
  // so a manual run of one the evaluability guard refuses used to answer 200
  // with an empty `ruleMatches` and nothing else. The editor read that as
  // success and navigated to Matches, presenting the PRESERVED matches from the
  // previous run as this run's result. The route reports the reason instead.
  describe("skipped", () => {
    it("explains a rule set skipped for unestablished play history", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      // Never synced — exactly the state a brand-new server, a source switch or
      // an in-flight Tracearr backfill leaves behind.
      const server = await createTestServer(user.id, { watchHistorySyncedAt: null });
      const ruleSet = await createTestRuleSet(user.id, {
        rules: [{ field: "playCount", operator: "equals", value: "0" }],
        serverIds: [server.id],
      });

      mockRunDetection.mockResolvedValue([]);

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules/run",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });
      const body = await expectJson<{ skipped: Array<{ ruleSetId: string; name: string; reason: string }> }>(response, 200);

      expect(body.skipped[0]?.reason).toMatch(/play activity/i);
      expect(body.skipped[0]?.reason).toMatch(/no established play history/i);
    });

    it("explains a rule set skipped because it is disabled", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const server = await createTestServer(user.id);
      const ruleSet = await createTestRuleSet(user.id, {
        enabled: false,
        rules: [{ field: "playCount", operator: "equals", value: "0" }],
        serverIds: [server.id],
      });

      mockRunDetection.mockResolvedValue([]);

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules/run",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });
      const body = await expectJson<{ skipped: Array<{ ruleSetId: string; name: string; reason: string }> }>(response, 200);
      expect(body.skipped[0]?.reason).toMatch(/disabled/i);
    });

    it("explains a rule set whose selected servers are all disabled", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const server = await createTestServer(user.id, { enabled: false });
      const ruleSet = await createTestRuleSet(user.id, {
        rules: [{ field: "playCount", operator: "equals", value: "0" }],
        serverIds: [server.id],
      });

      mockRunDetection.mockResolvedValue([]);

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules/run",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });
      const body = await expectJson<{ skipped: Array<{ ruleSetId: string; name: string; reason: string }> }>(response, 200);
      expect(body.skipped[0]?.reason).toMatch(/enabled/i);
    });

    // The reason is only derived for a rule set the caller NAMED and that is
    // missing from the results — an evaluated rule set must never be reported
    // as skipped, or the editor would refuse to navigate after a good run.
    it("is null when the named rule set was evaluated", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const ruleSet = await createTestRuleSet(user.id);
      mockRunDetection.mockResolvedValue([
        { ruleSet: { id: ruleSet.id, name: ruleSet.name }, items: [], count: 0 },
      ]);

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules/run",
        method: "POST",
        body: { ruleSetId: ruleSet.id },
      });
      const body = await expectJson<{ skipped: Array<{ ruleSetId: string; name: string; reason: string }> }>(response, 200);
      expect(body.skipped).toEqual([]);
    });

    // A full run only ever considers ENABLED rule sets, so reporting every
    // disabled one would be noise about rule sets the user turned off on
    // purpose. "It is disabled" is only an answer when they named that one.
    it("does not report disabled rule sets on a run over all rule sets", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      await createTestRuleSet(user.id, { enabled: false });
      mockRunDetection.mockResolvedValue([]);

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules/run",
        method: "POST",
        body: {},
      });
      const body = await expectJson<{ skipped: Array<{ ruleSetId: string; name: string; reason: string }> }>(response, 200);
      expect(body.skipped).toEqual([]);
    });

    // The "Re-evaluate All" path. Every enabled rule set the run passed over
    // has to be named, or the Matches page cannot tell a skipped rule set from
    // one that legitimately matched nothing — and blanks its row either way.
    it("names each enabled rule set skipped by a run over all rule sets", async () => {
      const user = await createTestUser();
      setMockSession({ isLoggedIn: true, userId: user.id });

      const server = await createTestServer(user.id, { watchHistorySyncedAt: null });
      const paused = await createTestRuleSet(user.id, {
        name: "Stale movies",
        rules: [{ field: "lastPlayedAt", operator: "lt", value: "2020-01-01" }],
        serverIds: [server.id],
      });
      const evaluated = await createTestRuleSet(user.id, {
        name: "Big files",
        rules: [{ field: "fileSize", operator: "gt", value: "1000" }],
        serverIds: [server.id],
      });

      mockRunDetection.mockResolvedValue([
        { ruleSet: { id: evaluated.id, name: evaluated.name }, items: [], count: 0 },
      ]);

      const response = await callRoute(POST, {
        url: "/api/lifecycle/rules/run",
        method: "POST",
        body: {},
      });
      const body = await expectJson<{ skipped: Array<{ ruleSetId: string; name: string; reason: string }> }>(response, 200);

      expect(body.skipped).toHaveLength(1);
      expect(body.skipped[0].ruleSetId).toBe(paused.id);
      expect(body.skipped[0].name).toBe("Stale movies");
      expect(body.skipped[0].reason).toMatch(/no established play history/i);
    });
  });
});
