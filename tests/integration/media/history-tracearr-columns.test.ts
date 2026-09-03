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

type HistoryRow = {
  id: string;
  serverUsername: string;
  watchedAt: string | null;
  deviceName: string | null;
  platform: string | null;
  source: string;
  watched: boolean | null;
  percentComplete: number | null;
  isTranscode: boolean | null;
  videoDecision: string | null;
  audioDecision: string | null;
  player: string | null;
  product: string | null;
  resolution: string | null;
  bitrate: number | null;
  segmentCount: number | null;
  durationMs: number | null;
  totalDurationMs: number | null;
  progressMs: number | null;
  mediaItem: { id: string; title: string; resolution: string | null };
};

type HistoryResponse = {
  items: HistoryRow[];
  pagination: { page: number; limit: number; hasMore: boolean; totalCount: number };
};

describe("GET /api/media/history — Tracearr columns", () => {
  let userId: string;
  let serverId: string;
  let libraryId: string;

  async function addWatch(
    mediaItemId: string,
    data: Partial<{
      serverUsername: string;
      watchedAt: Date;
      source: string;
      sourceEventId: string;
      watched: boolean;
      percentComplete: number;
      isTranscode: boolean;
      videoDecision: string;
      audioDecision: string;
      player: string;
      product: string;
      resolution: string;
      bitrate: number;
      segmentCount: number;
      durationMs: number;
      totalDurationMs: number;
      progressMs: number;
    }> = {},
  ) {
    return getTestPrisma().watchHistory.create({
      data: {
        mediaItemId,
        mediaServerId: serverId,
        serverUsername: data.serverUsername ?? "alice",
        watchedAt: data.watchedAt ?? new Date("2024-06-01T00:00:00Z"),
        ...data,
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
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    libraryId = library.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns the Tracearr playback columns for a TRACEARR row", async () => {
    // A 4K file streamed at 1080p — the point of carrying a per-play
    // resolution separate from the MediaItem's.
    const movie = await createTestMediaItem(libraryId, {
      title: "Arrival",
      resolution: "4k",
    });
    await addWatch(movie.id, {
      source: "TRACEARR",
      sourceEventId: "chain-1",
      watched: true,
      percentComplete: 92.5,
      isTranscode: true,
      videoDecision: "transcode",
      audioDecision: "copy",
      player: "Plex Web",
      product: "Plex for Apple TV",
      resolution: "1080p",
      bitrate: 8500,
      segmentCount: 3,
      durationMs: 6_000_000,
      totalDurationMs: 6_480_000,
      progressMs: 5_994_000,
    });

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, { url: "/api/media/history" }),
    );

    expect(data.items).toHaveLength(1);
    const row = data.items[0];
    expect(row.source).toBe("TRACEARR");
    expect(row.watched).toBe(true);
    expect(row.percentComplete).toBe(92.5);
    expect(row.isTranscode).toBe(true);
    expect(row.videoDecision).toBe("transcode");
    expect(row.audioDecision).toBe("copy");
    expect(row.player).toBe("Plex Web");
    expect(row.product).toBe("Plex for Apple TV");
    expect(row.bitrate).toBe(8500);
    expect(row.segmentCount).toBe(3);
    expect(row.durationMs).toBe(6_000_000);
    expect(row.totalDurationMs).toBe(6_480_000);
    expect(row.progressMs).toBe(5_994_000);
    // The delivered resolution, not the file's.
    expect(row.resolution).toBe("1080p");
    expect(row.mediaItem.resolution).toBe("4k");
  });

  it("returns nulls for the Tracearr columns on a NATIVE row", async () => {
    const movie = await createTestMediaItem(libraryId, { title: "Sicario" });
    await addWatch(movie.id);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, { url: "/api/media/history" }),
    );

    expect(data.items).toHaveLength(1);
    const row = data.items[0];
    // The migration default — a pre-existing row is correctly NATIVE.
    expect(row.source).toBe("NATIVE");
    expect(row.watched).toBeNull();
    expect(row.percentComplete).toBeNull();
    expect(row.isTranscode).toBeNull();
    expect(row.videoDecision).toBeNull();
    expect(row.audioDecision).toBeNull();
    expect(row.player).toBeNull();
    expect(row.product).toBeNull();
    expect(row.resolution).toBeNull();
    expect(row.bitrate).toBeNull();
    expect(row.segmentCount).toBeNull();
    expect(row.durationMs).toBeNull();
    expect(row.totalDurationMs).toBeNull();
    expect(row.progressMs).toBeNull();
    // The pre-existing columns still come through untouched.
    expect(row.serverUsername).toBe("alice");
    expect(row.watchedAt).toBe("2024-06-01T00:00:00.000Z");
  });

  it("keeps the username, type and search filters working", async () => {
    const movie = await createTestMediaItem(libraryId, { title: "Dune" });
    const other = await createTestMediaItem(libraryId, { title: "Blade Runner" });
    await addWatch(movie.id, {
      serverUsername: "alice",
      source: "TRACEARR",
      sourceEventId: "chain-alice",
      percentComplete: 41.2,
    });
    // A NATIVE row alongside it — sourceEventId stays null, which the unique
    // index treats as distinct, so native rows never collide.
    await addWatch(other.id, { serverUsername: "bob" });

    const byUser = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { username: "alice" },
      }),
    );
    expect(byUser.items).toHaveLength(1);
    expect(byUser.items[0].mediaItem.title).toBe("Dune");
    // Filtering must not cost the new columns.
    expect(byUser.items[0].percentComplete).toBe(41.2);

    const byType = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { type: "MOVIE" },
      }),
    );
    expect(byType.items).toHaveLength(2);

    const bySearch = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { search: "blade" },
      }),
    );
    expect(bySearch.items).toHaveLength(1);
    expect(bySearch.items[0].mediaItem.title).toBe("Blade Runner");
  });

  it("accepts sorting by a new Tracearr column", async () => {
    const low = await createTestMediaItem(libraryId, { title: "Low" });
    const high = await createTestMediaItem(libraryId, { title: "High" });
    await addWatch(low.id, {
      source: "TRACEARR",
      sourceEventId: "low",
      percentComplete: 12,
      resolution: "1080p",
    });
    await addWatch(high.id, {
      source: "TRACEARR",
      sourceEventId: "high",
      percentComplete: 88,
      resolution: "4K",
    });

    const desc = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { sortBy: "percentComplete", sortOrder: "desc" },
      }),
    );
    expect(desc.items.map((i) => i.mediaItem.title)).toEqual(["High", "Low"]);

    const asc = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { sortBy: "percentComplete", sortOrder: "asc" },
      }),
    );
    expect(asc.items.map((i) => i.mediaItem.title)).toEqual(["Low", "High"]);

    // The stream resolution sorts on WatchHistory, not the file's resolution.
    const byStreamRes = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { sortBy: "streamResolution", sortOrder: "asc" },
      }),
    );
    expect(byStreamRes.items).toHaveLength(2);
  });

  it("ignores an unknown sortBy instead of interpolating it into the SQL", async () => {
    const first = await createTestMediaItem(libraryId, { title: "Oldest" });
    const last = await createTestMediaItem(libraryId, { title: "Newest" });
    await addWatch(first.id, { watchedAt: new Date("2024-01-01T00:00:00Z") });
    await addWatch(last.id, { watchedAt: new Date("2024-12-01T00:00:00Z") });

    const bogus = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { sortBy: 'wh."id"; DROP TABLE "WatchHistory"' },
      }),
    );
    // Falls back to the watchedAt DESC default rather than reaching the query.
    expect(bogus.items.map((i) => i.mediaItem.title)).toEqual(["Newest", "Oldest"]);

    // The table is still there.
    expect(await getTestPrisma().watchHistory.count()).toBe(2);
  });

  it("pages tied rows without duplicating or dropping any", async () => {
    // Every row shares one watchedAt and a NULL percentComplete, so the sort
    // column is one big tie block — exactly the case where a sort without a
    // unique tiebreaker permutes between the two page requests.
    const watchedAt = new Date("2024-06-01T00:00:00Z");
    for (let i = 0; i < 6; i++) {
      const item = await createTestMediaItem(libraryId, { title: `Tie ${i}` });
      await addWatch(item.id, { watchedAt });
    }

    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const data = await expectJson<HistoryResponse>(
        await callRoute(GET, {
          url: "/api/media/history",
          searchParams: {
            page: String(page),
            limit: "2",
            sortBy: "percentComplete",
            sortOrder: "desc",
          },
        }),
      );
      expect(data.pagination.totalCount).toBe(6);
      expect(data.pagination.hasMore).toBe(page < 3);
      expect(data.items).toHaveLength(2);
      seen.push(...data.items.map((i) => i.id));
    }

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });
});
