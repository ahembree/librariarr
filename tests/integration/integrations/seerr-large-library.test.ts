/**
 * Seerr request statistics for a requested show longer than Postgres takes
 * bind parameters, against the real database. Watch correlation looks plays up
 * by the dedupKey of every canonical episode of every requested show. As a
 * Prisma `in` inside the WatchHistory → MediaItem relation filter that went out
 * as ~32k bind parameters per statement, and in the full suite's database
 * state each route took over 15 s; `completedPlaysByDedupKey` now sends the
 * keys as one array parameter. This pins both answers at 33k episodes. The
 * episodes are bulk-inserted in SQL.
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
  createTestSeerrInstance,
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

const mockGetRequests = vi.fn();

vi.mock("@/lib/seerr/seerr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seerr/seerr-client")>()),
  SeerrClient: vi.fn().mockImplementation(function () {
    return {
      getRequests: mockGetRequests,
      getMovie: vi.fn(),
      getTvShow: vi.fn(),
    };
  }),
}));

import { GET as statsGet } from "@/app/api/seerr/request-stats/route";
import { GET as userRequestsGet } from "@/app/api/seerr/users/[userKey]/requests/route";
import { invalidateSeerrCaches } from "@/lib/seerr/request-stats";

const prisma = getTestPrisma();

/** More requested episodes than a statement takes bind parameters. */
const EPISODES = 33_000;
const TVDB_ID = "500";

function tvRequest(id: number, username: string) {
  return {
    id,
    type: "tv",
    status: 2,
    media: {
      id,
      tmdbId: 1396,
      tvdbId: Number(TVDB_ID),
      status: 5,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    requestedBy: { id, email: `${username}@test.com`, username, plexUsername: username },
    modifiedBy: null,
    is4k: false,
    serverId: 0,
    profileId: 0,
    rootFolder: "/",
  };
}

/**
 * One show of `EPISODES` canonical episodes (ids `ep-1` … `ep-N`), each
 * carrying the show's TVDB id as Seerr matches it; alice has completed
 * episodes 1 and 2, abandoned episode 3 (a Tracearr play short of the
 * threshold) and bob watched episode 4.
 */
async function seedLargeRequestedShow() {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id, { type: "SERIES" });
  await prisma.$executeRawUnsafe(
    `INSERT INTO "MediaItem" (id, "libraryId", "ratingKey", title, type, "parentTitle",
       "seasonNumber", "episodeNumber", "seriesKey", "dedupKey", "dedupCanonical", "updatedAt")
     SELECT 'ep-' || g, $1, 'rk-' || g, 'Episode ' || g, 'SERIES'::"LibraryType", 'Big Show',
       1, g, 'tvdb:' || $2, 'series:tvdb:' || $2 || ':s1e' || g, true, now()
     FROM generate_series(1, $3::int) g`,
    library.id,
    TVDB_ID,
    EPISODES,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "MediaItemExternalId" (id, "mediaItemId", source, "externalId")
     SELECT 'ext-' || g, 'ep-' || g, 'TVDB', $1 FROM generate_series(1, $2::int) g`,
    TVDB_ID,
    EPISODES,
  );
  await prisma.watchHistory.createMany({
    data: [
      { mediaItemId: "ep-1", mediaServerId: server.id, serverUsername: "alice" },
      { mediaItemId: "ep-2", mediaServerId: server.id, serverUsername: "alice" },
      { mediaItemId: "ep-2", mediaServerId: server.id, serverUsername: "alice" },
      {
        mediaItemId: "ep-3",
        mediaServerId: server.id,
        serverUsername: "alice",
        source: "TRACEARR",
        sourceEventId: "abandoned",
        watched: false,
      },
      { mediaItemId: "ep-4", mediaServerId: server.id, serverUsername: "bob" },
    ],
  });
  // Refresh the planner statistics the way autovacuum's analyze would after a
  // bulk load. Without it, column statistics an earlier test file left behind
  // (gathered while these tables held a handful of rows) describe 33k fresh
  // rows, and the planner picks plans that take minutes: this file passed
  // alone and timed out only late in the full suite.
  await prisma.$executeRawUnsafe(`ANALYZE "MediaItem", "MediaItemExternalId", "WatchHistory"`);
  await createTestSeerrInstance(user.id);
  mockGetRequests.mockResolvedValue({
    pageInfo: { page: 1, pages: 1, results: 1 },
    results: [tvRequest(1, "alice")],
  });
  return user;
}

describe("Seerr request stats past the bind-parameter limit", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    invalidateSeerrCaches();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("GET /api/seerr/request-stats counts a requester's completed plays of a 33k-episode show", async () => {
    const user = await seedLargeRequestedShow();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const body = await expectJson<{
      users: Array<{ userKey: string; episodesWatched: number; episodesAvailable: number; seriesWithAnyEpisodeWatched: number }>;
      totals: { episodesWatched: number; episodesAvailable: number };
    }>(await callRoute(statsGet), 200);

    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({
      userKey: "alice",
      episodesWatched: 2,
      episodesAvailable: EPISODES,
      seriesWithAnyEpisodeWatched: 1,
    });
    expect(body.totals).toMatchObject({ episodesWatched: 2, episodesAvailable: EPISODES });
  });

  it("GET /api/seerr/users/[userKey]/requests reports the same plays for the requester", async () => {
    const user = await seedLargeRequestedShow();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const body = await expectJson<{
      requests: Array<{ type: string; seriesKey: string | null; watch: { watched: boolean; episodesWatched: number; episodesAvailable: number } }>;
    }>(await callRouteWithParams(userRequestsGet, { userKey: "alice" }), 200);

    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({
      type: "tv",
      seriesKey: `tvdb:${TVDB_ID}`,
      watch: { watched: true, episodesWatched: 2, episodesAvailable: EPISODES },
    });
  });
});
