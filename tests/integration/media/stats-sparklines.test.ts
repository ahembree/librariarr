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

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import AFTER mocks
import { GET } from "@/app/api/media/stats/sparklines/route";
import { GET as getTimeline } from "@/app/api/media/stats/timeline/route";
import { appCache } from "@/lib/cache/memory-cache";

type Points = { date: string; total: number }[];
const BASE = "/api/media/stats/sparklines";

describe("GET /api/media/stats/sparklines", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    await expectJson(await callRoute(GET, { url: `${BASE}?types=MOVIE` }), 401);
  });

  it("rejects a type that is not a library type", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    await expectJson(await callRoute(GET, { url: `${BASE}?types=MOVIE,PODCAST` }), 400);
  });

  it("returns 404 for a server that is not the admin's", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    await expectJson(await callRoute(GET, { url: `${BASE}?types=MOVIE&serverId=missing` }), 404);
  });

  it("answers an empty series for every tile when no server is enabled", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const body = await expectJson<{ series: Record<string, Points> }>(
      await callRoute(GET, { url: `${BASE}?types=MOVIE,SERIES` }),
    );
    expect(body.series).toEqual({ MOVIE: [], SERIES: [], ALL: [] });
  });

  it("answers each tile exactly as the timeline route does", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const server = await createTestServer(user.id);
    const movies = await createTestLibrary(server.id, { type: "MOVIE" });
    const shows = await createTestLibrary(server.id, { type: "SERIES" });
    await createTestMediaItem(movies.id, { addedAt: new Date("2024-01-15T12:00:00Z"), fileSize: BigInt(100) });
    await createTestMediaItem(movies.id, { addedAt: new Date("2024-03-10T12:00:00Z"), fileSize: BigInt(300) });
    await createTestMediaItem(shows.id, {
      type: "SERIES",
      addedAt: new Date("2024-02-02T12:00:00Z"),
      fileSize: BigInt(50),
      parentTitle: "Show",
    });

    const body = await expectJson<{ series: Record<string, Points> }>(
      await callRoute(GET, { url: `${BASE}?types=MOVIE,SERIES` }),
    );
    expect(Object.keys(body.series).sort()).toEqual(["ALL", "MOVIE", "SERIES"]);

    const timeline = async (query: string) =>
      (await expectJson<{ points: Points }>(
        await callRoute(getTimeline, { url: `/api/media/stats/timeline?dateField=addedAt&bin=month&${query}` }),
      )).points;
    expect(body.series.MOVIE).toEqual(await timeline("type=MOVIE"));
    expect(body.series.SERIES).toEqual(await timeline("type=SERIES"));
    expect(body.series.ALL).toEqual(await timeline("measure=size"));
    expect(body.series.MOVIE).toEqual([
      { date: "2024-01", total: 1 },
      { date: "2024-02", total: 0 },
      { date: "2024-03", total: 1 },
    ]);
  });

  it("answers only the size series when no type is asked for", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const server = await createTestServer(user.id);
    const movies = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(movies.id, { addedAt: new Date("2024-01-15T12:00:00Z"), fileSize: BigInt(100) });
    const body = await expectJson<{ series: Record<string, Points> }>(await callRoute(GET, { url: BASE }));
    expect(Object.keys(body.series)).toEqual(["ALL"]);
    expect(body.series.ALL).toEqual([{ date: "2024-01", total: 100 }]);
  });
});
