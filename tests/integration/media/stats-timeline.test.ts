import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

// Redirect prisma to test database — MUST come before route imports
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

import { GET } from "@/app/api/media/stats/timeline/route";

interface TimelineBody {
  points: { date: string; total: number }[];
  series: string[];
}

const BASE = "/api/media/stats/timeline";

describe("GET /api/media/stats/timeline", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function authedUser() {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    return user;
  }

  it("returns 401 when not authenticated", async () => {
    const response = await callRoute(GET, { url: `${BASE}?dateField=addedAt` });
    await expectJson(response, 401);
  });

  it("returns 400 for a missing or invalid dateField", async () => {
    await authedUser();
    await expectJson(await callRoute(GET, { url: BASE }), 400);
    await expectJson(
      await callRoute(GET, { url: `${BASE}?dateField=createdAt` }),
      400,
    );
  });

  it("returns 400 for an invalid bin", async () => {
    await authedUser();
    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&bin=decade`,
    });
    await expectJson(response, 400);
  });

  it("returns 400 for an invalid measure", async () => {
    await authedUser();
    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&measure=bytes`,
    });
    await expectJson(response, 400);
  });

  it("returns empty points when the user has no servers", async () => {
    await authedUser();
    const response = await callRoute(GET, { url: `${BASE}?dateField=addedAt` });
    const body = await expectJson<TimelineBody>(response, 200);
    expect(body.points).toEqual([]);
    expect(body.series).toEqual([]);
  });

  it("buckets item counts by month and fills gaps", async () => {
    const user = await authedUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id);
    await createTestMediaItem(library.id, { addedAt: new Date("2024-01-15T12:00:00Z") });
    await createTestMediaItem(library.id, { addedAt: new Date("2024-01-20T12:00:00Z") });
    // Gap: nothing added in February
    await createTestMediaItem(library.id, { addedAt: new Date("2024-03-10T12:00:00Z") });

    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&bin=month`,
    });
    const body = await expectJson<TimelineBody>(response, 200);
    expect(body.points).toEqual([
      { date: "2024-01", total: 2 },
      { date: "2024-02", total: 0 },
      { date: "2024-03", total: 1 },
    ]);
  });

  it("sums file sizes per bucket when measure=size", async () => {
    const user = await authedUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id);
    await createTestMediaItem(library.id, {
      addedAt: new Date("2024-01-15T12:00:00Z"),
      fileSize: 100n,
    });
    await createTestMediaItem(library.id, {
      addedAt: new Date("2024-01-20T12:00:00Z"),
      fileSize: 200n,
    });
    await createTestMediaItem(library.id, {
      addedAt: new Date("2024-02-10T12:00:00Z"),
      fileSize: 50n,
    });

    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&bin=month&measure=size`,
    });
    const body = await expectJson<TimelineBody>(response, 200);
    expect(body.points).toEqual([
      { date: "2024-01", total: 300 },
      { date: "2024-02", total: 50 },
    ]);
  });

  it("filters by media type", async () => {
    const user = await authedUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id);
    await createTestMediaItem(library.id, {
      addedAt: new Date("2024-01-15T12:00:00Z"),
      type: "MOVIE",
    });
    await createTestMediaItem(library.id, {
      addedAt: new Date("2024-01-16T12:00:00Z"),
      type: "SERIES",
    });

    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&bin=month&type=MOVIE`,
    });
    const body = await expectJson<TimelineBody>(response, 200);
    expect(body.points).toEqual([{ date: "2024-01", total: 1 }]);
  });

  it("returns 404 for a serverId belonging to another user", async () => {
    const owner = await createTestUser({ plexId: "other", username: "other" });
    const foreignServer = await createTestServer(owner.id);
    await authedUser();

    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&serverId=${foreignServer.id}`,
    });
    await expectJson(response, 404);
  });

  it("scopes results to the requested server", async () => {
    const user = await authedUser();
    const serverA = await createTestServer(user.id, { name: "A" });
    const serverB = await createTestServer(user.id, { name: "B" });
    const libraryA = await createTestLibrary(serverA.id);
    const libraryB = await createTestLibrary(serverB.id);
    await createTestMediaItem(libraryA.id, { addedAt: new Date("2024-01-15T12:00:00Z") });
    await createTestMediaItem(libraryB.id, { addedAt: new Date("2024-01-16T12:00:00Z") });
    await createTestMediaItem(libraryB.id, { addedAt: new Date("2024-01-17T12:00:00Z") });

    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&bin=month&serverId=${serverB.id}`,
    });
    const body = await expectJson<TimelineBody>(response, 200);
    expect(body.points).toEqual([{ date: "2024-01", total: 2 }]);
  });
});
