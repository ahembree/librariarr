/** Extra coverage for PUT /api/lifecycle/rules/[id]. */
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
  createTestRuleMatch,
  createTestCollection,
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
vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollectionById: vi.fn().mockResolvedValue(undefined),
  syncAllCollections: vi.fn().mockResolvedValue(undefined),
  removePlexCollection: vi.fn().mockResolvedValue(undefined),
  renameCollectionInPlex: vi.fn().mockResolvedValue(undefined),
  removeItemFromCollections: vi.fn().mockResolvedValue(undefined),
}));

import { PUT } from "@/app/api/lifecycle/rules/[id]/route";

const prisma = getTestPrisma();
const dummyRule = { id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" };

const put = (id: string, body: unknown, searchParams?: Record<string, string>) =>
  callRouteWithParams(PUT, { id }, { url: `/api/lifecycle/rules/${id}`, method: "PUT", body, searchParams });

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function withPending() {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  const lib = await createTestLibrary(server.id);
  const item = await createTestMediaItem(lib.id);
  const ruleSet = await createTestRuleSet(user.id, { actionEnabled: true, actionType: "DELETE_RADARR", rules: [dummyRule] });
  await createTestRuleMatch(ruleSet.id, item.id);
  const action = await prisma.lifecycleAction.create({
    data: { userId: user.id, mediaItemId: item.id, ruleSetId: ruleSet.id, actionType: "DELETE_RADARR", status: "PENDING", scheduledFor: new Date() },
  });
  setMockSession({ isLoggedIn: true, userId: user.id });
  return { user, server, item, ruleSet, action };
}

describe("PUT /api/lifecycle/rules/[id]", () => {
  it("rejects an invalid body", async () => {
    const { ruleSet } = await withPending();
    await expectJson(await put(ruleSet.id, { actionDelayDays: -1 }), 400);
  });

  it("refuses to arm a Change Quality Profile action with no target profile", async () => {
    const { ruleSet } = await withPending();
    const body = await expectJson<{ error: string }>(
      await put(ruleSet.id, { actionType: "CHANGE_QUALITY_PROFILE_RADARR", targetQualityProfileId: null }),
      400,
    );
    expect(body.error).toMatch(/target quality profile/);
    expect((await prisma.ruleSet.findUniqueOrThrow({ where: { id: ruleSet.id } })).actionType).toBe("DELETE_RADARR");
  });

  it("refuses a collection that does not exist or is of another library type", async () => {
    const { user, ruleSet } = await withPending();
    expect((await expectJson<{ error: string }>(await put(ruleSet.id, { collectionId: "missing" }), 400)).error).toBe("Collection not found");
    const tv = await createTestCollection(user.id, { type: "SERIES" });
    expect((await expectJson<{ error: string }>(await put(ruleSet.id, { collectionId: tv.id }), 400)).error).toMatch(/does not match/);
  });

  it("answers 404 for a rule set that is not there, even when only flags are sent", async () => {
    await withPending();
    await expectJson(await put("missing", { enabled: true }), 404);
  });

  it("writes every field it was sent and, by default, clears matches and pending actions", async () => {
    const { server, ruleSet, user } = await withPending();
    const collection = await createTestCollection(user.id, { type: "MOVIE" });

    const body = await expectJson<{ ruleSet: Record<string, unknown> }>(
      await put(ruleSet.id, {
        name: "Renamed",
        rules: [dummyRule],
        seriesScope: false,
        actionDelayDays: 14,
        addImportExclusion: true,
        searchAfterAction: true,
        addArrTags: ["leaving"],
        removeArrTags: ["keep"],
        enabled: true,
        collectionId: collection.id,
        discordNotifyOnAction: true,
        discordNotifyOnMatch: true,
        stickyMatches: true,
        serverIds: [server.id],
      }),
      200,
    );

    expect(body.ruleSet).toMatchObject({
      name: "Renamed", actionDelayDays: 14, addImportExclusion: true, searchAfterAction: true,
      addArrTags: ["leaving"], removeArrTags: ["keep"], collectionId: collection.id,
      discordNotifyOnAction: true, discordNotifyOnMatch: true, stickyMatches: true, serverIds: [server.id],
    });
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id, status: "PENDING" } })).toBe(0);
  });

  it("with clearMatches=false re-snapshots the action config onto PENDING actions and keeps the matches", async () => {
    const { ruleSet, action } = await withPending();

    await expectJson(
      await put(ruleSet.id, {
        targetQualityProfileId: 7,
        addImportExclusion: true,
        searchAfterAction: true,
        addArrTags: ["a"],
        removeArrTags: ["b"],
      }, { clearMatches: "false" }),
      200,
    );

    const after = await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(after).toMatchObject({
      status: "PENDING", targetQualityProfileId: 7, addImportExclusion: true, searchAfterAction: true,
      addArrTags: ["a"], removeArrTags: ["b"],
    });
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(1);
  });

  it("with clearMatches=false and nothing action-related, leaves PENDING actions untouched", async () => {
    const { ruleSet, action } = await withPending();
    await expectJson(await put(ruleSet.id, { discordNotifyOnMatch: true }, { clearMatches: "false" }), 200);
    const after = await prisma.lifecycleAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(after.updatedAt.getTime()).toBe(action.updatedAt.getTime());
  });
});
