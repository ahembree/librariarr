import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { computeWatchTrends, computeWatchLeaderboard } from "@/lib/media/watch-analytics";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

const prisma = getTestPrisma();

async function play(
  mediaItemId: string,
  mediaServerId: string,
  opts: { user?: string; watchedAt?: Date; device?: string | null; platform?: string | null } = {},
) {
  return prisma.watchHistory.create({
    data: {
      mediaItemId,
      mediaServerId,
      serverUsername: opts.user ?? "alice",
      watchedAt: opts.watchedAt ?? new Date(),
      deviceName: opts.device ?? null,
      platform: opts.platform ?? null,
    },
  });
}

beforeEach(cleanDatabase);
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("watch-analytics", () => {
  it("ranks recent trends and excludes plays outside the window", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);
    const movieA = await createTestMediaItem(lib.id, { title: "Popular", type: "MOVIE" });
    const movieB = await createTestMediaItem(lib.id, { title: "Quiet", type: "MOVIE" });
    const now = new Date();
    const old = new Date(now.getTime() - 400 * 86_400_000);

    await play(movieA.id, server.id, { user: "alice", watchedAt: now });
    await play(movieA.id, server.id, { user: "bob", watchedAt: now });
    await play(movieA.id, server.id, { user: "alice", watchedAt: now });
    await play(movieB.id, server.id, { user: "alice", watchedAt: now });
    await play(movieB.id, server.id, { user: "alice", watchedAt: old });

    const trends = await computeWatchTrends([server.id], { mediaType: "MOVIE", days: 30, limit: 10 });
    expect(trends[0].title).toBe("Popular");
    expect(trends[0].plays).toBe(3);
    expect(trends[0].users).toBe(2);
    expect(trends.find((t) => t.title === "Quiet")?.plays).toBe(1);
  });

  it("rolls series episode plays up to the parent series", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const ep1 = await createTestMediaItem(lib.id, { title: "E1", type: "SERIES", parentTitle: "My Show", seasonNumber: 1, episodeNumber: 1 });
    const ep2 = await createTestMediaItem(lib.id, { title: "E2", type: "SERIES", parentTitle: "My Show", seasonNumber: 1, episodeNumber: 2 });
    await play(ep1.id, server.id, { watchedAt: new Date() });
    await play(ep2.id, server.id, { watchedAt: new Date() });

    const trends = await computeWatchTrends([server.id], { days: 30, limit: 10 });
    const show = trends.find((t) => t.title === "My Show");
    expect(show?.plays).toBe(2);
    expect(show?.type).toBe("SERIES");
  });

  it("builds user/device leaderboards", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);
    const m = await createTestMediaItem(lib.id);
    await play(m.id, server.id, { user: "alice", device: "AppleTV", platform: "tvOS" });
    await play(m.id, server.id, { user: "alice", device: "AppleTV", platform: "tvOS" });
    await play(m.id, server.id, { user: "bob", device: "Web", platform: "Chrome" });

    const byUser = await computeWatchLeaderboard([server.id], { groupBy: "user", days: 30, limit: 10 });
    expect(byUser[0].key).toBe("alice");
    expect(byUser[0].plays).toBe(2);

    const byDevice = await computeWatchLeaderboard([server.id], { groupBy: "device", days: 30, limit: 10 });
    expect(byDevice.map((r) => r.key).sort()).toEqual(["AppleTV", "Web"]);
  });

  it("returns empty for no servers", async () => {
    expect(await computeWatchTrends([], { days: 30, limit: 10 })).toEqual([]);
    expect(await computeWatchLeaderboard([], { groupBy: "user", days: 30, limit: 10 })).toEqual([]);
  });
});
