/**
 * Extra coverage for the lifecycle action routes:
 *   GET  /api/lifecycle/actions            — history grouping of orphaned rows
 *   POST /api/lifecycle/actions/[id]       — force-retry's refusals
 *   POST /api/lifecycle/actions/execute    — API-key and member-exception paths
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
  createTestRuleMatch,
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
const mockExecuteAction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/actions")>();
  return { ...actual, executeAction: mockExecuteAction };
});
const mockSendDiscord = vi.hoisted(() => vi.fn());
vi.mock("@/lib/discord/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord/client")>();
  return { ...actual, sendDiscordNotification: mockSendDiscord };
});

import { GET } from "@/app/api/lifecycle/actions/route";
import { POST as retry } from "@/app/api/lifecycle/actions/[id]/route";
import { POST as execute } from "@/app/api/lifecycle/actions/execute/route";
import { runAsApiKey } from "@/lib/api-keys/principal";

const prisma = getTestPrisma();

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
  // mockReset, not only clear: a `…Once` a failed test never consumed must not
  // leak into the next one.
  mockExecuteAction.mockReset().mockResolvedValue({});
  mockSendDiscord.mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function movieSetup() {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id, { type: "MOVIE" });
  const item = await createTestMediaItem(library.id, { title: "Heat", year: 1995 });
  return { user, server, library, item };
}

function failedAction(userId: string, data: Record<string, unknown>) {
  return prisma.lifecycleAction.create({
    data: {
      userId,
      actionType: "DELETE_RADARR",
      status: "FAILED",
      scheduledFor: new Date(),
      arrInstanceId: "arr-1",
      ...data,
    } as never,
  });
}

const retryCall = (id: string) =>
  callRouteWithParams(retry, { id }, { url: `/api/lifecycle/actions/${id}`, method: "POST" });

describe("GET /api/lifecycle/actions — history", () => {
  it("groups actions of a deleted rule set under its recorded name, keeps the latest per item, and names a vanished item from its snapshot", async () => {
    const { user, item } = await movieSetup();
    const older = new Date("2025-01-01");
    const newer = new Date("2025-02-01");
    await prisma.lifecycleAction.createMany({
      data: [
        { userId: user.id, mediaItemId: item.id, ruleSetName: "Gone rule", ruleSetType: "MOVIE", actionType: "DELETE_RADARR", status: "COMPLETED", scheduledFor: older, mediaItemTitle: "Heat" },
        { userId: user.id, mediaItemId: item.id, ruleSetName: "Gone rule", ruleSetType: "MOVIE", actionType: "DELETE_RADARR", status: "COMPLETED", scheduledFor: newer, mediaItemTitle: "Heat" },
        { userId: user.id, mediaItemId: null, ruleSetName: null, ruleSetType: "MOVIE", actionType: "DELETE_RADARR", status: "COMPLETED", scheduledFor: newer, mediaItemTitle: "Vanished", mediaItemParentTitle: null },
      ],
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<{ groups: Array<{ ruleSet: { name: string; deleted?: boolean }; items: Array<{ scheduledFor: string; mediaItem: { id: string | null; title: string; type: string } }> }> }>(
      await callRoute(GET, { url: "/api/lifecycle/actions", searchParams: { status: "COMPLETED" } }),
      200,
    );

    const gone = body.groups.find((g) => g.ruleSet.name === "Gone rule")!;
    expect(gone.ruleSet.deleted).toBe(true);
    expect(gone.items).toHaveLength(1); // deduped to the latest
    expect(gone.items[0].scheduledFor).toBe(newer.toISOString());
    expect(gone.items[0].mediaItem).toMatchObject({ id: item.id, title: "Heat" });
    const orphan = body.groups.find((g) => g.ruleSet.name === "Deleted Rule Set")!;
    expect(orphan.ruleSet.deleted).toBe(true);
    expect(orphan.items).toHaveLength(1);
    expect(orphan.items[0].mediaItem).toMatchObject({ id: null, title: "Vanished", type: "MOVIE" });
    expect(body.groups).toHaveLength(2);
  });

  it("keeps the latest action per item across statuses for ALL, newest first, and never pairs two vanished items", async () => {
    const { user, item } = await movieSetup();
    await prisma.lifecycleAction.createMany({
      data: [
        { userId: user.id, mediaItemId: item.id, ruleSetName: "Gone rule", ruleSetType: "MOVIE", actionType: "DELETE_RADARR", status: "FAILED", scheduledFor: new Date("2025-01-01"), mediaItemTitle: "Heat" },
        { userId: user.id, mediaItemId: item.id, ruleSetName: "Gone rule", ruleSetType: "MOVIE", actionType: "DELETE_RADARR", status: "COMPLETED", scheduledFor: new Date("2025-03-01"), mediaItemTitle: "Heat" },
        // Two actions whose items are gone: each is its own row.
        { userId: user.id, mediaItemId: null, ruleSetName: "Gone rule", ruleSetType: "MOVIE", actionType: "DELETE_RADARR", status: "COMPLETED", scheduledFor: new Date("2025-02-01"), mediaItemTitle: "One" },
        { userId: user.id, mediaItemId: null, ruleSetName: "Gone rule", ruleSetType: "MOVIE", actionType: "DELETE_RADARR", status: "COMPLETED", scheduledFor: new Date("2025-02-01"), mediaItemTitle: "Two" },
      ],
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<{ groups: Array<{ ruleSet: { name: string }; items: Array<{ status: string; scheduledFor: string; mediaItem: { title: string } }> }> }>(
      await callRoute(GET, { url: "/api/lifecycle/actions", searchParams: { status: "ALL" } }),
      200,
    );

    expect(body.groups).toHaveLength(1);
    const items = body.groups[0].items;
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ status: "COMPLETED", scheduledFor: new Date("2025-03-01").toISOString() });
    expect(new Set(items.slice(1).map((i) => i.mediaItem.title))).toEqual(new Set(["One", "Two"]));

    // Filtered to FAILED, the older failure is the latest of its status.
    const failed = await expectJson<{ groups: Array<{ items: Array<{ status: string }> }> }>(
      await callRoute(GET, { url: "/api/lifecycle/actions", searchParams: { status: "FAILED" } }),
      200,
    );
    expect(failed.groups.flatMap((g) => g.items.map((i) => i.status))).toEqual(["FAILED"]);
  });
});

describe("POST /api/lifecycle/actions/[id] — refusals", () => {
  it("401 without a session, 404 for an unknown action", async () => {
    expect((await retryCall("nope")).status).toBe(401);
    const { user } = await movieSetup();
    setMockSession({ isLoggedIn: true, userId: user.id });
    await expectJson(await retryCall("nope"), 404);
  });

  it("refuses an action that is not FAILED, and one whose rule set was deleted", async () => {
    const { user, item } = await movieSetup();
    const ruleSet = await createTestRuleSet(user.id);
    const pending = await failedAction(user.id, { mediaItemId: item.id, ruleSetId: ruleSet.id, status: "PENDING" });
    const orphaned = await failedAction(user.id, { mediaItemId: item.id, ruleSetId: null });
    setMockSession({ isLoggedIn: true, userId: user.id });

    expect((await expectJson<{ error: string }>(await retryCall(pending.id), 400)).error).toMatch(/Only failed actions/);
    expect((await expectJson<{ error: string }>(await retryCall(orphaned.id), 400)).error).toMatch(/deleted rule sets/);
    expect(mockExecuteAction).not.toHaveBeenCalled();
  });

  it("refuses when the media item is gone, and when it is no longer a match", async () => {
    const { user, item } = await movieSetup();
    const ruleSet = await createTestRuleSet(user.id);
    const noItem = await failedAction(user.id, { mediaItemId: null, ruleSetId: ruleSet.id });
    const stale = await failedAction(user.id, { mediaItemId: item.id, ruleSetId: ruleSet.id });
    setMockSession({ isLoggedIn: true, userId: user.id });

    expect((await expectJson<{ error: string }>(await retryCall(noItem.id), 400)).error).toMatch(/media item no longer exists/);
    expect((await expectJson<{ error: string }>(await retryCall(stale.id), 400)).error).toMatch(/no longer a match/);
    expect(mockExecuteAction).not.toHaveBeenCalled();
  });

  it("drops an excepted member from a member-scoped retry and runs the rest", async () => {
    const user = await createTestUser();
    const lib = await createTestLibrary((await createTestServer(user.id)).id, { type: "SERIES" });
    const ep1 = await createTestMediaItem(lib.id, { type: "SERIES", title: "Pilot", parentTitle: "Lost", seasonNumber: 1, episodeNumber: 1 });
    const ep2 = await createTestMediaItem(lib.id, { type: "SERIES", title: "Two", parentTitle: "Lost", seasonNumber: 1, episodeNumber: 2 });
    const ruleSet = await createTestRuleSet(user.id, { type: "SERIES" });
    await createTestRuleMatch(ruleSet.id, ep1.id, { title: "Lost" }); // no member list: no narrowing
    const action = await failedAction(user.id, {
      mediaItemId: ep1.id, ruleSetId: ruleSet.id, actionType: "DELETE_FILES_SONARR",
      matchedMediaItemIds: [ep1.id, ep2.id], mediaItemTitle: "Lost",
    });
    await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: ep2.id } });
    setMockSession({ isLoggedIn: true, userId: user.id });

    await expectJson(await retryCall(action.id), 200);

    expect(mockExecuteAction.mock.calls[0][0].matchedMediaItemIds).toEqual([ep1.id]);
    const after = await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(after.status).toBe("COMPLETED");
    expect(after.matchedMediaItemIds).toEqual([ep1.id]);
  });

  it("records the Arr error and answers 500 when the retry fails again", async () => {
    const { user, item } = await movieSetup();
    const ruleSet = await createTestRuleSet(user.id);
    await createTestRuleMatch(ruleSet.id, item.id);
    const action = await failedAction(user.id, { mediaItemId: item.id, ruleSetId: ruleSet.id, error: "old" });
    mockExecuteAction.mockRejectedValueOnce(new Error("Radarr unreachable at 10.0.0.5"));
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<{ error: string }>(await retryCall(action.id), 500);

    expect(body.error).toBe("Radarr unreachable at [internal]");
    const after = await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(after.status).toBe("FAILED");
    expect(after.error).toBe("Radarr unreachable at [internal]");
    expect(after.executedAt).not.toBeNull();
    // The match survives a failed retry.
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(1);
  });

  it("passes skipTitleValidation through when asked", async () => {
    const { user, item } = await movieSetup();
    const ruleSet = await createTestRuleSet(user.id);
    await createTestRuleMatch(ruleSet.id, item.id);
    const action = await failedAction(user.id, { mediaItemId: item.id, ruleSetId: ruleSet.id });
    setMockSession({ isLoggedIn: true, userId: user.id });

    await expectJson(
      await callRouteWithParams(retry, { id: action.id }, {
        url: `/api/lifecycle/actions/${action.id}`, method: "POST", searchParams: { skipTitleValidation: "true" },
      }),
      200,
    );
    expect(mockExecuteAction.mock.calls[0][0].skipTitleValidation).toBe(true);
  });
});

describe("POST /api/lifecycle/actions/execute — extra paths", () => {
  const exec = (body: unknown) => callRoute(execute, { url: "/api/lifecycle/actions/execute", method: "POST", body });

  it("under an API key, refuses a request that names no items (never 'every match')", async () => {
    const { user, item } = await movieSetup();
    const ruleSet = await createTestRuleSet(user.id, { actionEnabled: true, actionType: "DELETE_RADARR", arrInstanceId: "arr-1" });
    await createTestRuleMatch(ruleSet.id, item.id);
    setMockSession({ isLoggedIn: true, userId: user.id });

    const res = await runAsApiKey(
      { keyId: "k", userId: user.id, name: "script", prefix: "lbr_abc", scopes: ["lifecycle:execute"] },
      () => exec({ ruleSetId: ruleSet.id }),
    );

    expect((await expectJson<{ error: string }>(res, 400)).error).toMatch(/mediaItemIds is required/);
    expect(mockExecuteAction).not.toHaveBeenCalled();
  });

  it("Execute All with no stored matches asks for detection first", async () => {
    const { user } = await movieSetup();
    const ruleSet = await createTestRuleSet(user.id, { actionEnabled: true, actionType: "DO_NOTHING" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    expect((await expectJson<{ error: string }>(await exec({ ruleSetId: ruleSet.id }), 400)).error).toMatch(/run detection first/);
  });

  it("leaves another show's members alone when only one show has an excepted episode", async () => {
    const user = await createTestUser();
    const lib = await createTestLibrary((await createTestServer(user.id)).id, { type: "SERIES" });
    const mk = (show: string, n: number) =>
      createTestMediaItem(lib.id, { type: "SERIES", title: `${show} ${n}`, parentTitle: show, seasonNumber: 1, episodeNumber: n });
    const a1 = await mk("Alpha", 1);
    const a2 = await mk("Alpha", 2);
    const b1 = await mk("Beta", 1);
    const b2 = await mk("Beta", 2);
    const ruleSet = await createTestRuleSet(user.id, {
      type: "SERIES", seriesScope: true, actionEnabled: true, actionType: "DELETE_FILES_SONARR", arrInstanceId: "arr-1",
    });
    await createTestRuleMatch(ruleSet.id, a1.id, { title: "Alpha", parentTitle: null, memberIds: [a1.id, a2.id] });
    await createTestRuleMatch(ruleSet.id, b1.id, { title: "Beta", parentTitle: null, memberIds: [b1.id, b2.id] });
    await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: a2.id } });
    setMockSession({ isLoggedIn: true, userId: user.id });

    expect((await expectJson<{ executed: number }>(await exec({ ruleSetId: ruleSet.id }), 200)).executed).toBe(2);

    const byItem = new Map(mockExecuteAction.mock.calls.map((c) => [c[0].mediaItem.id, [...c[0].matchedMediaItemIds].sort()]));
    expect(byItem.get(a1.id)).toEqual([a1.id]);
    expect(byItem.get(b1.id)).toEqual([b1.id, b2.id].sort());
  });

  it("notifies Discord of failures when the rule set asks for it", async () => {
    const { user, item } = await movieSetup();
    const ruleSet = await createTestRuleSet(user.id, { name: "Notify", actionEnabled: true, actionType: "DO_NOTHING" });
    await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { discordNotifyOnAction: true } });
    await prisma.appSettings.create({ data: { userId: user.id, discordWebhookUrl: "https://discord.example/hook" } });
    await createTestRuleMatch(ruleSet.id, item.id);
    mockExecuteAction.mockRejectedValueOnce(new Error("boom"));
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<{ failed: number }>(await exec({ ruleSetId: ruleSet.id, mediaItemIds: [item.id] }), 200);

    expect(body.failed).toBe(1);
    expect(mockSendDiscord).toHaveBeenCalledTimes(1);
    expect(mockSendDiscord.mock.calls[0][0]).toBe("https://discord.example/hook");
    expect(mockSendDiscord.mock.calls[0][1].username).toBe("Librariarr");
  });

  it("answers normally when sending the Discord notification fails", async () => {
    const { user, item } = await movieSetup();
    const ruleSet = await createTestRuleSet(user.id, { actionEnabled: true, actionType: "DO_NOTHING" });
    await prisma.ruleSet.update({ where: { id: ruleSet.id }, data: { discordNotifyOnAction: true } });
    await prisma.appSettings.create({ data: { userId: user.id, discordWebhookUrl: "https://discord.example/hook" } });
    await createTestRuleMatch(ruleSet.id, item.id);
    mockExecuteAction.mockRejectedValueOnce(new Error("boom"));
    mockSendDiscord.mockRejectedValueOnce(new Error("discord down"));
    setMockSession({ isLoggedIn: true, userId: user.id });

    expect((await expectJson<{ failed: number }>(await exec({ ruleSetId: ruleSet.id, mediaItemIds: [item.id] }), 200)).failed).toBe(1);
    expect(mockSendDiscord).toHaveBeenCalledTimes(1);
  });
});

describe("episode-scoped Unmonitor (Series rule set, series scope off)", () => {
  const exec = (body: unknown) => callRoute(execute, { url: "/api/lifecycle/actions/execute", method: "POST", body });

  async function showSetup(seriesScope: boolean) {
    const user = await createTestUser();
    const lib = await createTestLibrary((await createTestServer(user.id)).id, { type: "SERIES" });
    const ep1 = await createTestMediaItem(lib.id, { type: "SERIES", title: "Pilot", parentTitle: "Lost", seasonNumber: 1, episodeNumber: 1 });
    const ep2 = await createTestMediaItem(lib.id, { type: "SERIES", title: "Two", parentTitle: "Lost", seasonNumber: 1, episodeNumber: 2 });
    const ruleSet = await createTestRuleSet(user.id, {
      type: "SERIES", seriesScope, actionEnabled: true, actionType: "UNMONITOR_SONARR", arrInstanceId: "arr-1",
    });
    const match = await createTestRuleMatch(ruleSet.id, ep1.id, { title: "Lost", parentTitle: null, memberIds: [ep1.id, ep2.id] });
    setMockSession({ isLoggedIn: true, userId: user.id });
    return { user, ep1, ep2, ruleSet, match };
  }

  it("Execute runs it on the matched episodes; with series scope on, on the series", async () => {
    const off = await showSetup(false);
    await expectJson(await exec({ ruleSetId: off.ruleSet.id }), 200);
    expect(mockExecuteAction.mock.calls[0][0]).toMatchObject({ episodeScope: true });
    expect([...mockExecuteAction.mock.calls[0][0].matchedMediaItemIds].sort()).toEqual([off.ep1.id, off.ep2.id].sort());

    mockExecuteAction.mockClear();
    const on = await showSetup(true);
    await expectJson(await exec({ ruleSetId: on.ruleSet.id }), 200);
    expect(mockExecuteAction.mock.calls[0][0]).toMatchObject({ episodeScope: false });
  });

  it("Retry runs it on the episodes the match still holds", async () => {
    const { user, ep1, ep2, ruleSet, match } = await showSetup(false);
    await prisma.ruleMatch.update({ where: { id: match.id }, data: { itemData: { title: "Lost", parentTitle: null, memberIds: [ep2.id] } } });
    const action = await failedAction(user.id, {
      mediaItemId: ep1.id, ruleSetId: ruleSet.id, actionType: "UNMONITOR_SONARR",
      matchedMediaItemIds: [ep1.id, ep2.id], mediaItemTitle: "Lost",
    });

    await expectJson(await retryCall(action.id), 200);

    expect(mockExecuteAction.mock.calls[0][0]).toMatchObject({
      episodeScope: true,
      matchedMediaItemIds: [ep2.id],
      targetTitle: "Lost S01E02",
    });
  });

  it("Pending estimates the show again once an episode matches that a completed action did not act on", async () => {
    const { user, ep1, ep2, ruleSet, match } = await showSetup(false);
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: ep1.id, ruleSetId: ruleSet.id, actionType: "UNMONITOR_SONARR",
        status: "COMPLETED", scheduledFor: new Date(), executedAt: new Date(), arrInstanceId: "arr-1",
        matchedMediaItemIds: [ep1.id],
      },
    });
    const pendingIds = async () => {
      const body = await expectJson<{ groups: { items: { id: string }[] }[] }>(
        await callRoute(GET, { url: "/api/lifecycle/actions" }),
        200,
      );
      return body.groups.flatMap((g) => g.items.map((i) => i.id));
    };

    expect(await pendingIds()).toEqual([`rm_${match.id}`]);

    await prisma.lifecycleAction.updateMany({ where: { ruleSetId: ruleSet.id }, data: { matchedMediaItemIds: [ep1.id, ep2.id] } });
    expect(await pendingIds()).toEqual([]);
  });

  it("Pending lists, and Execute acts on, only the episodes a completed action did not cover", async () => {
    const { user, ep1, ep2, ruleSet } = await showSetup(false);
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: ep1.id, ruleSetId: ruleSet.id, actionType: "UNMONITOR_SONARR",
        status: "COMPLETED", scheduledFor: new Date(), executedAt: new Date(), arrInstanceId: "arr-1",
        matchedMediaItemIds: [ep1.id],
      },
    });

    const body = await expectJson<{ groups: { items: { mediaItem: { matchedEpisodes?: number } }[] }[] }>(
      await callRoute(GET, { url: "/api/lifecycle/actions" }),
      200,
    );
    expect(body.groups[0].items[0].mediaItem.matchedEpisodes).toBe(1);

    await expectJson(await exec({ ruleSetId: ruleSet.id, mediaItemIds: [ep1.id] }), 200);
    expect(mockExecuteAction.mock.calls[0][0].matchedMediaItemIds).toEqual([ep2.id]);
  });

  it("counts what a completed action under the show's previous representative covered", async () => {
    const { user, ep1, ep2, ruleSet, match } = await showSetup(false);
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: ep1.id, ruleSetId: ruleSet.id, actionType: "UNMONITOR_SONARR",
        status: "COMPLETED", scheduledFor: new Date(), executedAt: new Date(), arrInstanceId: "arr-1",
        matchedMediaItemIds: [ep1.id, ep2.id],
      },
    });
    // ep1 stopped matching; ep2 is the show's representative now.
    await prisma.ruleMatch.update({
      where: { id: match.id },
      data: { mediaItemId: ep2.id, itemData: { title: "Lost", parentTitle: null, memberIds: [ep2.id] } },
    });

    const body = await expectJson<{ groups: unknown[] }>(await callRoute(GET, { url: "/api/lifecycle/actions" }), 200);
    expect(body.groups).toEqual([]);
    await expectJson(await exec({ ruleSetId: ruleSet.id }), 400);
    expect(mockExecuteAction).not.toHaveBeenCalled();
  });

  it("with series scope on, estimates the series while an episode it matches was never covered", async () => {
    const { user, ep1, ep2, ruleSet, match } = await showSetup(true);
    const done = await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: ep1.id, ruleSetId: ruleSet.id, actionType: "UNMONITOR_SONARR",
        status: "COMPLETED", scheduledFor: new Date(), executedAt: new Date(), arrInstanceId: "arr-1",
        matchedMediaItemIds: [ep1.id],
      },
    });
    const ids = async () =>
      (await expectJson<{ groups: { items: { id: string }[] }[] }>(await callRoute(GET, { url: "/api/lifecycle/actions" }), 200))
        .groups.flatMap((g) => g.items.map((i) => i.id));

    expect(await ids()).toEqual([`rm_${match.id}`]);
    await prisma.lifecycleAction.update({ where: { id: done.id }, data: { matchedMediaItemIds: [ep1.id, ep2.id] } });
    expect(await ids()).toEqual([]);
  });

  it("Execute acts on a scheduled action's own episodes, not every episode the match holds", async () => {
    const { user, ep1, ep2, ruleSet } = await showSetup(false);
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: ep1.id, ruleSetId: ruleSet.id, actionType: "UNMONITOR_SONARR",
        status: "PENDING", scheduledFor: new Date(), arrInstanceId: "arr-1", matchedMediaItemIds: [ep2.id],
      },
    });
    await expectJson(await exec({ ruleSetId: ruleSet.id }), 200);
    expect(mockExecuteAction.mock.calls[0][0].matchedMediaItemIds).toEqual([ep2.id]);
  });

  it("refuses when every episode of the selection was already acted on", async () => {
    const { user, ep1, ep2, ruleSet } = await showSetup(false);
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id, mediaItemId: ep1.id, ruleSetId: ruleSet.id, actionType: "UNMONITOR_SONARR",
        status: "COMPLETED", scheduledFor: new Date(), executedAt: new Date(), arrInstanceId: "arr-1",
        matchedMediaItemIds: [ep1.id, ep2.id],
      },
    });
    await expectJson(await exec({ ruleSetId: ruleSet.id }), 400);
    expect(mockExecuteAction).not.toHaveBeenCalled();
  });
});

