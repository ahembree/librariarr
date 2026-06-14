import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestRadarrInstance,
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
  });
});
