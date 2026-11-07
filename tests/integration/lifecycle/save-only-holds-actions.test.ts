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
import { GET as listActions } from "@/app/api/lifecycle/actions/route";
import { POST as executeRoute } from "@/app/api/lifecycle/actions/execute/route";
import { POST as retryRoute } from "@/app/api/lifecycle/actions/[id]/route";
import { POST as runRoute } from "@/app/api/lifecycle/rules/run/route";
import { eventBus, type AppEvent } from "@/lib/events/event-bus";
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

type Listing = {
  groups: Array<{
    ruleSet: { id: string; actionsHeldSince: string | null };
    items: Array<{ id: string; status: string; mediaItem: { id: string | null } }>;
  }>;
};

/** What the Pending page lists (`?status=` picks its tab). */
async function listing(status = "PENDING"): Promise<Listing> {
  return expectJson<Listing>(await callRoute(listActions, { url: `/api/lifecycle/actions?status=${status}` }), 200);
}

function groupOf(body: Listing, ruleSetId: string) {
  const group = body.groups.find((g) => g.ruleSet.id === ruleSetId);
  expect(group, `no group for rule set ${ruleSetId}`).toBeDefined();
  return group!;
}

async function storedHold(ruleSetId: string): Promise<Date | null> {
  return (await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSetId } })).actionsHeldSince;
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

  it("holds the actions when sticky matches are turned off, until detection drops what the rules no longer select", async () => {
    const { user, target, other, ruleSet, editorBody } = await armed();
    // Sticky: a match the rules stopped selecting stays, and so does its
    // pending action — "Other" (2010), matched when the rules said 2010.
    await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { stickyMatches: true } });
    await prisma.ruleMatch.create({ data: { ruleSetId: ruleSet.id, mediaItemId: other.id, itemData: { id: other.id, title: "Other", year: 2010 } } });
    const otherAction = await prisma.lifecycleAction.create({
      data: {
        userId: user.id, ruleSetId: ruleSet.id, mediaItemId: other.id, actionType: "DELETE_RADARR", status: "PENDING",
        scheduledFor: new Date(), arrInstanceId: editorBody.arrInstanceId, mediaItemTitle: "Other", mediaItemYear: 2010,
      },
    });

    // Turned off with "Save only": the rules are unchanged, the matches kept.
    await expectJson(await saveOnly(ruleSet.id, { ...editorBody, stickyMatches: false }), 200);
    expect(await storedHold(ruleSet.id)).not.toBeNull();

    // Nothing runs — "Other" least of all, which only stickiness kept.
    await executeLifecycleActions(user.id);
    expect(actedOn()).toEqual([]);
    expect((await expectJson<{ error: string }>(await callRoute(executeRoute, { method: "POST", body: { ruleSetId: ruleSet.id } }), 409)).error)
      .toMatch(/edited \(its rules, servers or sticky matches\) or enabled again/);
    expect(groupOf(await listing(), ruleSet.id).ruleSet.actionsHeldSince).not.toBeNull();

    // Detection drops "Other" and cancels its action, and releases the rest.
    await processLifecycleRules(user.id);
    expect(await storedHold(ruleSet.id)).toBeNull();
    expect(await prisma.lifecycleAction.findUnique({ where: { id: otherAction.id } })).toBeNull();
    await executeLifecycleActions(user.id);
    expect(actedOn()).toEqual([target.id]);
  });

  it("holds the actions when a disabled rule set is enabled again, until detection re-checks its frozen matches", async () => {
    const { user, target, other, ruleSet, editorBody } = await armed();
    // Turned off while keeping its matches ("Save only"): its pending action is
    // cancelled, its match frozen — detection skips a disabled rule set.
    await expectJson(await saveOnly(ruleSet.id, { ...editorBody, enabled: false }), 200);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id, status: "PENDING" } })).toBe(0);
    // Meanwhile the item stops matching: re-identified as a 2010 film.
    await prisma.mediaItem.update({ where: { id: target.id }, data: { year: 2010 } });
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id, mediaItemId: target.id } })).toBe(1);

    // Turned back on with "Save only".
    await expectJson(await saveOnly(ruleSet.id, { ...editorBody, enabled: true }), 200);
    expect(await storedHold(ruleSet.id)).not.toBeNull();

    // Execute All acts on stored matches: the frozen one must wait for detection.
    const refused = await expectJson<{ error: string }>(
      await callRoute(executeRoute, { method: "POST", body: { ruleSetId: ruleSet.id } }),
      409,
    );
    expect(refused.error).toMatch(/or enabled again since its matches were detected/);
    expect(actedOn()).toEqual([]);

    // Detection re-checks it: the frozen match is gone, the hold released.
    await processLifecycleRules(user.id);
    expect(await storedHold(ruleSet.id)).toBeNull();
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id, mediaItemId: target.id } })).toBe(0);
    expect(other.id).not.toBe(target.id);
  });

  it("holds the actions when the rule set list's switch enables it again", async () => {
    const { ruleSet } = await armed();
    await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { enabled: false } });

    // The list's switch sends only `enabled` (and clears the matches).
    await expectJson(
      await callRouteWithParams(PUT, { id: ruleSet.id }, { url: `/api/lifecycle/rules/${ruleSet.id}`, method: "PUT", body: { enabled: true } }),
      200,
    );

    expect(await storedHold(ruleSet.id)).not.toBeNull();
  });

  it("does not hold for turning sticky matches on, or disabling", async () => {
    const { ruleSet, editorBody } = await armed();
    await expectJson(await saveOnly(ruleSet.id, { ...editorBody, stickyMatches: true }), 200);
    expect(await storedHold(ruleSet.id)).toBeNull();
    await expectJson(await saveOnly(ruleSet.id, { ...editorBody, stickyMatches: true, enabled: false }), 200);
    expect(await storedHold(ruleSet.id)).toBeNull();
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

  describe("The Pending listing reports a held rule set", () => {
    it("returns the hold and its time on the held rule set's group, and no hold on another's", async () => {
      const { user, server, target, other, ruleSet, editorBody } = await armed();
      // A second rule set with an action of its own on the other film, never edited.
      const untouched = await createTestRuleSet(user.id, {
        name: "Delete 2010",
        type: "MOVIE",
        rules: yearRule("equals", "2010"),
        serverIds: [server.id],
        actionEnabled: true,
        actionType: "DELETE_RADARR",
        arrInstanceId: ruleSet.arrInstanceId!,
        actionDelayDays: 0,
      });
      await processLifecycleRules(user.id);

      const before = await listing();
      expect(groupOf(before, ruleSet.id).ruleSet.actionsHeldSince).toBeNull();
      expect(groupOf(before, untouched.id).ruleSet.actionsHeldSince).toBeNull();

      await expectJson(await saveOnly(ruleSet.id, { ...editorBody, rules: yearRule("greaterThanOrEqual", "2015") }), 200);
      const since = await storedHold(ruleSet.id);
      expect(since).not.toBeNull();

      const held = await listing();
      const heldGroup = groupOf(held, ruleSet.id);
      expect(heldGroup.ruleSet.actionsHeldSince).toBe(since!.toISOString());
      // The held rule set's action is still listed, pending — the page marks it.
      expect(heldGroup.items.map((i) => [i.mediaItem.id, i.status])).toEqual([[target.id, "PENDING"]]);
      const untouchedGroup = groupOf(held, untouched.id);
      expect(untouchedGroup.ruleSet.actionsHeldSince).toBeNull();
      expect(untouchedGroup.items.map((i) => i.mediaItem.id)).toEqual([other.id]);
    });

    it("returns it on the Failed and All listings too, where Retry is offered", async () => {
      const { ruleSet, action, editorBody } = await armed();
      await prisma.lifecycleAction.update({ where: { id: action.id }, data: { status: "FAILED", error: "timeout" } });

      await expectJson(await saveOnly(ruleSet.id, { ...editorBody, rules: yearRule("equals", "2010") }), 200);
      const since = (await storedHold(ruleSet.id))!.toISOString();

      for (const status of ["FAILED", "ALL"]) {
        const group = groupOf(await listing(status), ruleSet.id);
        expect(group.ruleSet.actionsHeldSince).toBe(since);
        expect(group.items.map((i) => [i.id, i.status])).toEqual([[action.id, "FAILED"]]);
      }
    });

    it("drops the hold once a detection run re-checks the rule set, and announces that run", async () => {
      const { user, target, ruleSet, editorBody } = await armed();
      const seen: AppEvent[] = [];
      const unsubscribe = eventBus.subscribe((event) => seen.push(event));
      try {
        // Re-evaluate on the Matches page (the run route), then the scheduled run.
        const detections: Array<() => Promise<unknown>> = [
          async () =>
            expectJson(
              await callRoute(runRoute, {
                method: "POST",
                body: { ruleSetId: ruleSet.id, fullReEval: true, processActions: true },
              }),
              200,
            ),
          () => processLifecycleRules(user.id),
        ];
        for (const [round, detect] of detections.entries()) {
          // A different edit each time: a save of the stored rules holds nothing.
          await expectJson(await saveOnly(ruleSet.id, { ...editorBody, rules: yearRule("greaterThanOrEqual", String(2014 + round)) }), 200);
          expect(groupOf(await listing(), ruleSet.id).ruleSet.actionsHeldSince).not.toBeNull();
          seen.length = 0;

          await detect();

          // The Pending page re-reads its listing on this event…
          expect(seen.filter((e) => e.type === "lifecycle:detection-completed" && e.userId === user.id)).toHaveLength(1);
          // …and the listing no longer reports a hold, the still-matching action kept.
          const released = groupOf(await listing(), ruleSet.id);
          expect(released.ruleSet.actionsHeldSince).toBeNull();
          expect(released.items.map((i) => i.mediaItem.id)).toEqual([target.id]);
        }
      } finally {
        unsubscribe();
      }
    });
  });
});
