import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestRadarrInstance,
  createTestSonarrInstance,
} from "../../setup/test-helpers";
import type { QueryDefinition } from "@/lib/query/types";
import { convertQueryToRuleSetBody } from "@/lib/query/convert-to-rule";

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
  syncCollection: vi.fn().mockResolvedValue(undefined),
  syncCollectionById: vi.fn().mockResolvedValue(undefined),
  syncAllCollections: vi.fn().mockResolvedValue(undefined),
  removePlexCollection: vi.fn().mockResolvedValue(undefined),
  renameCollectionInPlex: vi.fn().mockResolvedValue(undefined),
  removeItemFromCollections: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "@/app/api/lifecycle/rules/route";
import { PUT } from "@/app/api/lifecycle/rules/[id]/route";

function makeQuery(overrides: Partial<QueryDefinition> = {}): QueryDefinition {
  return {
    mediaTypes: ["MOVIE"],
    serverIds: [],
    groups: [
      {
        id: "g1",
        condition: "AND",
        rules: [
          { id: "r1", field: "title", operator: "contains", value: "matrix", condition: "AND" },
          { id: "r2", field: "playCount", operator: "equals", value: 0, condition: "AND" },
        ],
        groups: [],
      },
    ],
    sortBy: "title",
    sortOrder: "asc",
    ...overrides,
  };
}

describe("Convert query → lifecycle rule set", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("creates a rule set from a converted query body", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = convertQueryToRuleSetBody(makeQuery(), {
      name: "Old Unwatched Movies",
      targetLibraryType: "MOVIE",
      serverIds: [server.id],
    });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules",
      method: "POST",
      body,
    });
    const payload = await expectJson<{
      ruleSet: {
        id: string;
        name: string;
        type: string;
        enabled: boolean;
        actionEnabled: boolean;
        actionType: string | null;
        serverIds: string[];
        rules: unknown;
      };
    }>(response, 201);

    expect(payload.ruleSet.name).toBe("Old Unwatched Movies");
    expect(payload.ruleSet.type).toBe("MOVIE");
    expect(payload.ruleSet.enabled).toBe(true);
    expect(payload.ruleSet.actionEnabled).toBe(false);
    expect(payload.ruleSet.actionType).toBeNull();
    expect(payload.ruleSet.serverIds).toEqual([server.id]);

    const prisma = getTestPrisma();
    const persisted = await prisma.ruleSet.findUnique({
      where: { id: payload.ruleSet.id },
    });
    expect(persisted).not.toBeNull();
    const persistedRules = persisted!.rules as unknown as Array<{
      rules: Array<{ field: string }>;
    }>;
    expect(persistedRules[0].rules.map((r) => r.field)).toEqual([
      "title",
      "playCount",
    ]);
  });

  it("drops incompatible rules before persisting", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id });

    const query = makeQuery({
      mediaTypes: ["MOVIE", "SERIES"],
      groups: [
        {
          id: "g1",
          condition: "AND",
          rules: [
            { id: "r1", field: "title", operator: "contains", value: "x", condition: "AND" },
            { id: "r2", field: "availableEpisodeCount", operator: "greaterThan", value: 5, condition: "AND" },
          ],
          groups: [],
        },
      ],
    });

    const body = convertQueryToRuleSetBody(query, {
      name: "Movies Only",
      targetLibraryType: "MOVIE",
      serverIds: [server.id],
    });

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules",
      method: "POST",
      body,
    });
    const payload = await expectJson<{ ruleSet: { id: string; rules: unknown } }>(
      response,
      201,
    );

    const prisma = getTestPrisma();
    const persisted = await prisma.ruleSet.findUnique({
      where: { id: payload.ruleSet.id },
    });
    const persistedRules = persisted!.rules as unknown as Array<{
      rules: Array<{ field: string }>;
    }>;
    expect(persistedRules[0].rules.map((r) => r.field)).toEqual(["title"]);
  });

  it("transfers the matching Arr instance from the query", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const radarr = await createTestRadarrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = convertQueryToRuleSetBody(
      makeQuery({
        arrServerIds: { radarr: radarr.id, sonarr: "snr-2", lidarr: "ldr-3" },
      }),
      { name: "Movies w/ Arr", targetLibraryType: "MOVIE", serverIds: [server.id] },
    );

    const response = await callRoute(POST, {
      url: "/api/lifecycle/rules",
      method: "POST",
      body,
    });
    const payload = await expectJson<{
      ruleSet: { id: string; arrInstanceId: string | null };
    }>(response, 201);
    expect(payload.ruleSet.arrInstanceId).toBe(radarr.id);

    const prisma = getTestPrisma();
    const persisted = await prisma.ruleSet.findUnique({
      where: { id: payload.ruleSet.id },
    });
    expect(persisted?.arrInstanceId).toBe(radarr.id);
  });

  it("transfers seriesScope based on includeEpisodes", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id });

    const aggBody = convertQueryToRuleSetBody(
      makeQuery({ mediaTypes: ["SERIES"], includeEpisodes: false }),
      { name: "Series Agg", targetLibraryType: "SERIES", serverIds: [server.id] },
    );
    const aggResponse = await callRoute(POST, {
      url: "/api/lifecycle/rules",
      method: "POST",
      body: aggBody,
    });
    const aggPayload = await expectJson<{ ruleSet: { seriesScope: boolean } }>(aggResponse, 201);
    expect(aggPayload.ruleSet.seriesScope).toBe(true);

    const epBody = convertQueryToRuleSetBody(
      makeQuery({ mediaTypes: ["SERIES"], includeEpisodes: true }),
      { name: "Series Ep", targetLibraryType: "SERIES", serverIds: [server.id] },
    );
    const epResponse = await callRoute(POST, {
      url: "/api/lifecycle/rules",
      method: "POST",
      body: epBody,
    });
    const epPayload = await expectJson<{ ruleSet: { seriesScope: boolean } }>(epResponse, 201);
    expect(epPayload.ruleSet.seriesScope).toBe(false);
  });

  it("creates a query using Resolution, grouped by show, as a rule set with series scope off", async () => {
    // Resolution describes one episode, which a whole-show rule may not use:
    // with series scope on the save would be refused.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id });
    const query = makeQuery({
      mediaTypes: ["SERIES"],
      includeEpisodes: false,
      groups: [{
        id: "g1",
        condition: "AND",
        rules: [
          { id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" },
          { id: "r2", field: "resolution", operator: "equals", value: "720P", condition: "AND" },
        ],
        groups: [],
      }],
    });

    const body = convertQueryToRuleSetBody(query, { name: "Low-res shows", targetLibraryType: "SERIES", serverIds: [server.id] });
    const payload = await expectJson<{ ruleSet: { id: string; seriesScope: boolean } }>(
      await callRoute(POST, { url: "/api/lifecycle/rules", method: "POST", body }),
      201,
    );

    expect(payload.ruleSet.seriesScope).toBe(false);
    expect((await getTestPrisma().ruleSet.findUniqueOrThrow({ where: { id: payload.ruleSet.id } })).seriesScope).toBe(false);
  });

  it("creates a music query using Audio Codec as a rule set with artist scope off", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id });
    const query = makeQuery({
      mediaTypes: ["MUSIC"],
      groups: [{
        id: "g1",
        condition: "AND",
        rules: [{ id: "r1", field: "audioCodec", operator: "equals", value: "mp3", condition: "AND" }],
        groups: [],
      }],
    });

    const body = convertQueryToRuleSetBody(query, { name: "MP3s", targetLibraryType: "MUSIC", serverIds: [server.id] });
    const payload = await expectJson<{ ruleSet: { seriesScope: boolean } }>(
      await callRoute(POST, { url: "/api/lifecycle/rules", method: "POST", body }),
      201,
    );

    expect(payload.ruleSet.seriesScope).toBe(false);
  });

  it("never creates a whole-show action over the per-episode criteria it turned the scope off for", async () => {
    // A query grouped by show reading Genre (stored per episode): created with
    // series scope off and its action off, it cannot then be armed with an
    // action on the whole show — only one on the matched episodes.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const sonarr = await createTestSonarrInstance(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id });
    const query = makeQuery({
      mediaTypes: ["SERIES"],
      includeEpisodes: false,
      groups: [{
        id: "g1",
        condition: "AND",
        rules: [{ id: "r1", field: "genre", operator: "contains", value: "Rock", condition: "AND", negate: true }],
        groups: [],
      }],
    });

    const body = convertQueryToRuleSetBody(query, { name: "Not rock", targetLibraryType: "SERIES", serverIds: [server.id] });
    expect(body).toMatchObject({ seriesScope: false, actionEnabled: false });
    expect("actionType" in body).toBe(false);
    const { ruleSet } = await expectJson<{ ruleSet: { id: string; actionEnabled: boolean; actionType: string | null } }>(
      await callRoute(POST, { url: "/api/lifecycle/rules", method: "POST", body }),
      201,
    );
    expect(ruleSet).toMatchObject({ actionEnabled: false, actionType: null });

    const put = (data: Record<string, unknown>) =>
      callRouteWithParams(PUT, { id: ruleSet.id }, { url: `/api/lifecycle/rules/${ruleSet.id}`, method: "PUT", body: data });
    const refused = await expectJson<{ details: string[] }>(
      await put({ actionEnabled: true, actionType: "DELETE_SONARR", arrInstanceId: sonarr.id }),
      400,
    );
    expect(refused.details[0]).toMatch(/"Delete from Sonarr" acts on the whole show, .*Genre/);
    // Asked for directly too: the create schema refuses the same combination.
    const direct = await expectJson<{ details: string[] }>(
      await callRoute(POST, { url: "/api/lifecycle/rules", method: "POST", body: { ...body, name: "Direct", actionEnabled: true, actionType: "DELETE_SONARR", arrInstanceId: sonarr.id } }),
      400,
    );
    expect(direct.details[0]).toMatch(/^actionType: "Delete from Sonarr" acts on the whole show/);
    await expectJson(await put({ actionEnabled: true, actionType: "DELETE_FILES_SONARR", arrInstanceId: sonarr.id }), 200);
  });

  it("rejects a duplicate name + type combination", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = convertQueryToRuleSetBody(makeQuery(), {
      name: "Dup",
      targetLibraryType: "MOVIE",
      serverIds: [server.id],
    });

    const first = await callRoute(POST, {
      url: "/api/lifecycle/rules",
      method: "POST",
      body,
    });
    await expectJson(first, 201);

    const second = await callRoute(POST, {
      url: "/api/lifecycle/rules",
      method: "POST",
      body,
    });
    const errorBody = await expectJson<{ error: string }>(second, 409);
    expect(errorBody.error).toMatch(/already exists/i);
    expect(await getTestPrisma().ruleSet.count({ where: { name: "Dup" } })).toBe(1);
  });
});
