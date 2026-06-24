import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanDatabase,
  disconnectTestDb,
  getTestPrisma,
} from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Disable in-memory cache so each test gets fresh DB results
vi.mock("@/lib/cache/memory-cache", () => {
  const noopCache = {
    get: () => undefined,
    set: () => {},
    getOrSet: async (_k: string, compute: () => Promise<unknown>) => compute(),
    invalidate: () => {},
    invalidatePrefix: () => {},
    clear: () => {},
  };
  return { MemoryCache: vi.fn(() => noopCache), appCache: noopCache };
});

// Import route handler AFTER mocks
import { GET } from "@/app/api/media/history/route";

type HistoryResponse = {
  items: Array<{ mediaItem: { title: string; parentTitle: string | null } }>;
};

describe("GET /api/media/history", () => {
  let userId: string;
  let serverId: string;
  let libraryId: string;

  async function addWatch(mediaItemId: string) {
    await getTestPrisma().watchHistory.create({
      data: {
        mediaItemId,
        mediaServerId: serverId,
        serverUsername: "alice",
        watchedAt: new Date("2024-06-01T00:00:00Z"),
      },
    });
  }

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true, plexToken: "token" });
    const server = await createTestServer(userId);
    serverId = server.id;
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    libraryId = library.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    clearMockSession();
    const response = await callRoute(GET, { url: "/api/media/history" });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("matches the episode title", async () => {
    const episode = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "Memories of Boom Boom Mountain",
      parentTitle: "Adventure Time",
      seasonNumber: 1,
      episodeNumber: 10,
    });
    await addWatch(episode.id);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { search: "Boom Boom" },
      }),
    );

    expect(data.items).toHaveLength(1);
    expect(data.items[0].mediaItem.title).toBe(
      "Memories of Boom Boom Mountain",
    );
  });

  it("matches the series name via parentTitle", async () => {
    const ep1 = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "Slumber Party Panic",
      parentTitle: "Adventure Time",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    const ep2 = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "Trouble in Lumpy Space",
      parentTitle: "Adventure Time",
      seasonNumber: 1,
      episodeNumber: 2,
    });
    // An unrelated episode that should not match.
    const other = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "Pilot",
      parentTitle: "Regular Show",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await addWatch(ep1.id);
    await addWatch(ep2.id);
    await addWatch(other.id);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { search: "adventure time" },
      }),
    );

    expect(data.items).toHaveLength(2);
    expect(
      data.items.every((i) => i.mediaItem.parentTitle === "Adventure Time"),
    ).toBe(true);
  });

  it("returns no rows for a non-matching search", async () => {
    const episode = await createTestMediaItem(libraryId, {
      type: "SERIES",
      title: "Slumber Party Panic",
      parentTitle: "Adventure Time",
    });
    await addWatch(episode.id);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { search: "Breaking Bad" },
      }),
    );

    expect(data.items).toHaveLength(0);
  });
});
