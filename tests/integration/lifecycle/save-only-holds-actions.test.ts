/**
 * "Save only" after editing what a rule set matches.
 *
 * Regression: a PUT with `?clearMatches=false` kept every RuleMatch and every
 * PENDING action unless the Arr instance or the series scope changed. The
 * executor checks only that an action's RuleMatch row exists, and detection
 * and execution run on separate schedules, so after narrowing a Delete rule
 * set's rules the action on an item the new rules no longer select still ran
 * — from the schedule or from Execute on the Pending page — before detection
 * re-checked it.
 *
 * Now such a save holds the rule set's actions (`RuleSet.actionsHeldSince`)
 * until a detection run has evaluated it under the new rules. That run
 * releases them: the ones still matching keep their dates, the rest are
 * cancelled.
 *
 * `executeAction` is mocked: a call to it is the request reaching the Arr app.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestExternalId,
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

const { mockExecuteAction } = vi.hoisted(() => ({ mockExecuteAction: vi.fn() }));

vi.mock("@/lib/lifecycle/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lifecycle/actions")>()),
  executeAction: mockExecuteAction,
}));
vi.mock("@/lib/discord/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord/client")>()),
  sendDiscordNotification: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/sync/sync-server", () => ({ syncMediaServer: vi.fn() }));
vi.mock("@/lib/sync/sync-incremental", () => ({
  syncMediaServerItems: vi.fn().mockResolvedValue({ status: "fell-back", upserted: 0, deleted: 0, reason: "test" }),
}));
vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollection: vi.fn(),
  syncCollectionById: vi.fn(),
  syncAllCollections: vi.fn(),
  removeItemFromCollections: vi.fn(),
  removePlexCollection: vi.fn(),
  renameCollectionInPlex: vi.fn(),
}));

import { processLifecycleRules, executeLifecycleActions } from "@/lib/lifecycle/processor";
import { detectAndSaveMatches } from "@/lib/lifecycle/detect-matches";
import { PUT } from "@/app/api/lifecycle/rules/[id]/route";
import { POST as executeRoute } from "@/app/api/lifecycle/actions/execute/route";
import { POST as retryRoute } from "@/app/api/lifecycle/actions/[id]/route";
import { _resetExecuteInFlightForTesting } from "@/lib/lifecycle/execute-in-flight";

const prisma = getTestPrisma();

function yearRule(operator: string, value: string) {
  return [
    {
      id: "g1",
      condition: "AND",
      rules: [{ id: "r1", field: "year", operator, value, condition: "AND" }],
      groups: [],
    },
  ];
}

/** The PUT the rule editor sends: every field, with "Save only". */
function saveOnly(ruleSetId: string, body: Record<string, unknown>) {
  return callRouteWithParams(PUT, { id: ruleSetId }, {
    url: `/api/lifecycle/rules/${ruleSetId}`,
    method: "PUT",
    body,
    searchParams: { clearMatches: "false" },
  });
}

/** Which items reached the Arr app. */
function actedOn(): string[] {
  return mockExecuteAction.mock.calls.map((c) => (c[0] as { mediaItem: { id: string } }).mediaItem.id);
}

/**
 * A Delete from Radarr rule set (no delay) whose rules — Year = 2020 — match
 * "Keep Me Safe" (2020) and not "Other" (2010), detected and scheduled, its
 * action due now.
 */
async function armed() {
  const user = await createTestUser();
  await prisma.appSettings.create({ data: { userId: user.id } });
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id, { type: "MOVIE" });
  const target = await createTestMediaItem(library.id, { title: "Keep Me Safe", year: 2020, type: "MOVIE" });
  const other = await createTestMediaItem(library.id, { title: "Other", year: 2010, type: "MOVIE" });
  await createTestExternalId(target.id, "TMDB", "1001");
  await createTestExternalId(other.id, "TMDB", "1002");
  const rules = yearRule("equals", "2020");
  const radarr = await createTestRadarrInstance(user.id);
  const ruleSet = await createTestRuleSet(user.id, {
    name: "Delete 2020",
    type: "MOVIE",
    rules,
    serverIds: [server.id],
    actionEnabled: true,
    actionType: "DELETE_RADARR",
    arrInstanceId: radarr.id,
    actionDelayDays: 0,
  });
  setMockSession({ isLoggedIn: true, userId: user.id });

  await processLifecycleRules(user.id);
  const action = await prisma.lifecycleAction.findFirstOrThrow({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
  expect(action.mediaItemId).toBe(target.id);

  const editorBody = {
    name: ruleSet.name,
    rules,
    enabled: true,
    actionEnabled: true,
    actionType: "DELETE_RADARR",
    actionDelayDays: 0,
    arrInstanceId: radarr.id,
    targetQualityProfileId: null,
    addImportExclusion: false,
    searchAfterAction: false,
    addArrTags: [],
    removeArrTags: [],
    collectionId: null,
    discordNotifyOnAction: false,
    discordNotifyOnMatch: false,
    stickyMatches: false,
    serverIds: [server.id],
  };
  return { user, server, library, target, other, ruleSet, action, editorBody };
}

describe("Save only after a change to what a rule set matches", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    _resetExecuteInFlightForTesting();
    mockExecuteAction.mockResolvedValue({});
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("does not run the action the edited rules no longer select before detection re-checks it", async () => {
    const { user, target, other, ruleSet, action, editorBody } = await armed();

    // Narrow the rules away from the armed item, keeping the matches.
    await expectJson(await saveOnly(ruleSet.id, { ...editorBody, rules: yearRule("equals", "2010") }), 200);
    // The matches stay visible, the action stays pending with its date…
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id, mediaItemId: target.id } })).toBe(1);
    expect(await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: action.id } })).toMatchObject({
      status: "PENDING", scheduledFor: action.scheduledFor,
    });

    // …but the scheduled executor leaves it alone.
    await executeLifecycleActions(user.id);
    expect(actedOn()).toEqual([]);
    expect((await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("PENDING");

    // Detection under the new rules drops the stale action and arms the new match.
    await processLifecycleRules(user.id);
    expect((await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } })).actionsHeldSince).toBeNull();
    expect(await prisma.lifecycleAction.findUnique({ where: { id: action.id } })).toBeNull();

    await executeLifecycleActions(user.id);
    expect(actedOn()).toEqual([other.id]);
  });

  it("refuses Execute on the Pending page (and the public API, which runs it) until detection re-checks", async () => {
    const { target, ruleSet, editorBody } = await armed();

    await expectJson(await saveOnly(ruleSet.id, { ...editorBody, rules: yearRule("equals", "2010") }), 200);
    for (const body of [{ ruleSetId: ruleSet.id }, { ruleSetId: ruleSet.id, mediaItemIds: [target.id] }]) {
      const refused = await expectJson<{ error: string }>(
        await callRoute(executeRoute, { method: "POST", body }),
        409,
      );
      expect(refused.error).toMatch(/re-run detection/);
    }
    expect(actedOn()).toEqual([]);
  });

  it("re-arms an action that still matches, keeping its date, once detection re-checks it", async () => {
    const { user, target, ruleSet, action, editorBody } = await armed();

    // Still selects the armed item (2020 ≥ 2015).
    await expectJson(await saveOnly(ruleSet.id, { ...editorBody, rules: yearRule("greaterThanOrEqual", "2015") }), 200);
    await executeLifecycleActions(user.id);
    expect(actedOn()).toEqual([]);

    await processLifecycleRules(user.id);
    const rearmed = await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(rearmed).toMatchObject({ status: "PENDING", scheduledFor: action.scheduledFor });

    await executeLifecycleActions(user.id);
    expect(actedOn()).toEqual([target.id]);
  });

  it("holds the action after a change of servers too", async () => {
    const { user, server, ruleSet, editorBody } = await armed();
    const second = await createTestServer(user.id);

    await expectJson(await saveOnly(ruleSet.id, { ...editorBody, serverIds: [server.id, second.id] }), 200);
    await executeLifecycleActions(user.id);

    expect(actedOn()).toEqual([]);
  });

  it("does not hold anything when a save leaves what the rule set matches unchanged", async () => {
    const { user, target, ruleSet, editorBody } = await armed();

    // The editor resends the rules (here with their keys in another order, as
    // they come back from the database) and the servers with a rename.
    const [group] = yearRule("equals", "2020");
    const reordered = [{ groups: [], rules: [{ condition: "AND", value: "2020", operator: "equals", field: "year", id: "r1" }], condition: group.condition, id: group.id }];
    await expectJson(await saveOnly(ruleSet.id, { ...editorBody, name: "Renamed", rules: reordered }), 200);
    expect((await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } })).actionsHeldSince).toBeNull();

    await executeLifecycleActions(user.id);
    expect(actedOn()).toEqual([target.id]);
  });

  it("refuses to force-retry a failed action of a held rule set", async () => {
    const { target, ruleSet, action, editorBody } = await armed();
    await prisma.lifecycleAction.update({ where: { id: action.id }, data: { status: "FAILED", error: "timeout" } });

    await expectJson(await saveOnly(ruleSet.id, { ...editorBody, rules: yearRule("equals", "2010") }), 200);
    const refused = await expectJson<{ error: string }>(
      await callRouteWithParams(retryRoute, { id: action.id }, { method: "POST" }),
      409,
    );

    expect(refused.error).toMatch(/re-run detection/);
    expect(actedOn()).toEqual([]);
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id, mediaItemId: target.id } })).toBe(1);
  });

  it("keeps the hold a later save set when a detection run of the older rules finishes", async () => {
    const { user, server, ruleSet } = await armed();
    const readWithOldRules = new Date("2026-01-01T00:00:00.000Z");
    const laterSave = new Date("2026-01-01T00:00:05.000Z");
    await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { actionsHeldSince: laterSave } });

    const config = {
      id: ruleSet.id, name: ruleSet.name, userId: user.id, type: "MOVIE" as const, rules: ruleSet.rules,
      seriesScope: true, serverIds: [server.id], actionEnabled: true, actionType: "DELETE_RADARR",
      actionDelayDays: 0, arrInstanceId: ruleSet.arrInstanceId, addImportExclusion: false, addArrTags: [],
      removeArrTags: [], stickyMatches: false,
    };
    await detectAndSaveMatches({ ...config, actionsHeldSince: readWithOldRules }, [server.id]);
    expect((await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } })).actionsHeldSince).toEqual(laterSave);

    // The run that read the rules the later save wrote releases it.
    await detectAndSaveMatches({ ...config, actionsHeldSince: laterSave }, [server.id]);
    expect((await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } })).actionsHeldSince).toBeNull();
  });
});
