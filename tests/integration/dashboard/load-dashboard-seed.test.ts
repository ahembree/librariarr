import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
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

import { loadDashboardSeed } from "@/lib/dashboard/load-dashboard-seed";
import { appCache } from "@/lib/cache/memory-cache";
import { GET as getStats } from "@/app/api/media/stats/route";
import { GET as getSparklines } from "@/app/api/media/stats/sparklines/route";
import { GET as getRecentlyAdded } from "@/app/api/media/recently-added/route";
import { GET as getLifecycleSummary } from "@/app/api/lifecycle/summary/route";
import { GET as getScheduleInfo } from "@/app/api/settings/schedule-info/route";
import { GET as getSyncStatus } from "@/app/api/sync/status/route";
import { GET as getServers } from "@/app/api/servers/route";

/**
 * The server render answers the dashboard's opening reads through the routes'
 * own handlers, so each zone hydrates with exactly what its request would have
 * returned. Compared here with a request to each route.
 */
describe("loadDashboardSeed", () => {
  beforeEach(async () => {
    appCache.clear();
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function seedLibrary() {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Home" });
    const movies = await createTestLibrary(server.id, { type: "MOVIE", title: "Movies" });
    await createTestMediaItem(movies.id, { title: "Alpha", type: "MOVIE", fileSize: BigInt(1_000_000) });
    await createTestMediaItem(movies.id, { title: "Bravo", type: "MOVIE", fileSize: BigInt(2_000_000) });
    setMockSession({ userId: user.id, isLoggedIn: true });
    return user;
  }

  it("answers each read with the body its route answers", async () => {
    await seedLibrary();
    const seed = await loadDashboardSeed(["MOVIE"]);

    const routes = [
      ["/api/media/stats", getStats],
      ["/api/media/stats/sparklines?types=MOVIE", getSparklines],
      ["/api/media/recently-added?limit=24", getRecentlyAdded],
      ["/api/lifecycle/summary", getLifecycleSummary],
      ["/api/settings/schedule-info", getScheduleInfo],
      ["/api/sync/status", getSyncStatus],
      ["/api/servers?fields=basic", getServers],
    ] as const;
    for (const [url, handler] of routes) {
      const direct = await (await callRoute(handler, { url })).json();
      expect(seed.bodies[url], url).toEqual(direct);
    }
    expect((seed.bodies["/api/media/stats"] as { movieCount: number }).movieCount).toBe(2);
  });

  it("answers nothing for a signed-out request (the layout redirects it)", async () => {
    const seed = await loadDashboardSeed([]);
    expect(seed.bodies).toEqual({});
  });
});
