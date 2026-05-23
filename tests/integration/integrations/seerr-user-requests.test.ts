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
  createTestSeerrInstance,
  createTestExternalId,
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
const mockGetMovie = vi.fn();
const mockGetTvShow = vi.fn();

vi.mock("@/lib/seerr/seerr-client", () => ({
  SeerrClient: vi.fn().mockImplementation(function () {
    return {
      getRequests: mockGetRequests,
      getMovie: mockGetMovie,
      getTvShow: mockGetTvShow,
    };
  }),
}));

import { GET } from "@/app/api/seerr/users/[userKey]/requests/route";
import { appCache } from "@/lib/cache/memory-cache";

function makeRequest(
  id: number,
  type: "movie" | "tv",
  requestedBy: { id: number; username: string; plexUsername?: string | null },
  media: { tmdbId?: number; tvdbId?: number | null; status?: number },
  overrides?: { createdAt?: string; status?: number; is4k?: boolean }
) {
  return {
    id,
    type,
    status: overrides?.status ?? 2,
    media: {
      id,
      tmdbId: media.tmdbId ?? 0,
      tvdbId: media.tvdbId ?? null,
      status: media.status ?? 5,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    createdAt: overrides?.createdAt ?? "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    requestedBy: {
      id: requestedBy.id,
      email: `${requestedBy.username}@test.com`,
      username: requestedBy.username,
      plexUsername: requestedBy.plexUsername ?? undefined,
    },
    modifiedBy: null,
    is4k: overrides?.is4k ?? false,
    serverId: 0,
    profileId: 0,
    rootFolder: "/",
  };
}

describe("GET /api/seerr/users/[userKey]/requests", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
    vi.clearAllMocks();
    mockGetRequests.mockResolvedValue({
      pageInfo: { page: 1, pages: 1, results: 0 },
      results: [],
    });
    mockGetMovie.mockResolvedValue({
      id: 0,
      title: "Mock Movie",
      originalTitle: "",
      posterPath: "/mock.jpg",
      backdropPath: null,
      overview: "",
      releaseDate: "2023-01-01",
    });
    mockGetTvShow.mockResolvedValue({
      id: 0,
      name: "Mock Show",
      originalName: "",
      posterPath: "/mock.jpg",
      backdropPath: null,
      overview: "",
      firstAirDate: "2023-01-01",
    });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const res = await callRouteWithParams(GET, { userKey: "alice" });
    expect(res.status).toBe(401);
  });

  it("returns empty when user has no Seerr instances", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{ user: unknown; requests: unknown[] }>(
      await callRouteWithParams(GET, { userKey: "alice" }),
      200
    );
    expect(body.user).toBeNull();
    expect(body.requests).toEqual([]);
  });

  it("filters requests to the matching userKey only", async () => {
    const user = await createTestUser();
    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 3 },
      results: [
        makeRequest(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 100 }),
        makeRequest(2, "movie", { id: 2, username: "bob", plexUsername: "bob" }, { tmdbId: 101 }),
        makeRequest(3, "tv", { id: 1, username: "alice", plexUsername: "alice" }, { tvdbId: 200 }),
      ],
    });

    const body = await expectJson<{
      user: { seerrUsername: string; plexUsername: string };
      requests: { seerrId: number; type: string }[];
    }>(await callRouteWithParams(GET, { userKey: "alice" }), 200);

    expect(body.user.seerrUsername).toBe("alice");
    expect(body.requests).toHaveLength(2);
    expect(body.requests.map((r) => r.seerrId).sort()).toEqual([1, 3]);
  });

  it("resolves movie requests to library MediaItems via TMDB id", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, {
      type: "MOVIE",
      title: "The Matrix",
      year: 1999,
    });
    const prisma = getTestPrisma();
    await prisma.mediaItem.update({
      where: { id: movie.id },
      data: { dedupKey: "movie-dedup-1" },
    });
    await createTestExternalId(movie.id, "TMDB", "603");

    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 1 },
      results: [
        makeRequest(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 603 }),
      ],
    });

    const body = await expectJson<{
      requests: {
        title: string;
        year: number | null;
        posterUrl: string;
        mediaItem: { id: string; route: string } | null;
      }[];
    }>(await callRouteWithParams(GET, { userKey: "alice" }), 200);

    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].title).toBe("The Matrix");
    expect(body.requests[0].year).toBe(1999);
    expect(body.requests[0].mediaItem).toEqual({ id: movie.id, route: "movie" });
    expect(body.requests[0].posterUrl).toBe(`/api/media/${movie.id}/image`);
    // Should not fall back to Seerr API since it's in library
    expect(mockGetMovie).not.toHaveBeenCalled();
  });

  it("resolves series via any canonical episode's id (Librariarr stores only episodes)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const prisma = getTestPrisma();

    // Two episodes only (mirrors how sync stores TV libraries — no show-level row)
    const ep1 = await createTestMediaItem(library.id, {
      type: "SERIES",
      title: "Pilot",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    const ep2 = await createTestMediaItem(library.id, {
      type: "SERIES",
      title: "Cat's in the Bag",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 2,
    });
    await prisma.mediaItem.update({
      where: { id: ep1.id },
      data: { dedupKey: "bb-s01e01" },
    });
    await prisma.mediaItem.update({
      where: { id: ep2.id },
      data: { dedupKey: "bb-s01e02" },
    });
    await createTestExternalId(ep1.id, "TVDB", "81189");
    await createTestExternalId(ep2.id, "TVDB", "81189");

    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 1 },
      results: [
        makeRequest(1, "tv", { id: 1, username: "alice", plexUsername: "alice" }, { tvdbId: 81189 }),
      ],
    });

    const body = await expectJson<{
      requests: {
        title: string;
        mediaItem: { id: string; route: string } | null;
        posterUrl: string;
        watch: { episodesAvailable: number; episodesWatched: number };
      }[];
    }>(await callRouteWithParams(GET, { userKey: "alice" }), 200);

    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].title).toBe("Breaking Bad");
    // Link target is the first canonical episode (sorted by S01E01)
    expect(body.requests[0].mediaItem).toEqual({ id: ep1.id, route: "show" });
    expect(body.requests[0].posterUrl).toBe(`/api/media/${ep1.id}/image?type=parent`);
    expect(body.requests[0].watch.episodesAvailable).toBe(2);
  });

  it("falls back to Seerr API when media is not in library", async () => {
    const user = await createTestUser();
    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 1 },
      results: [
        makeRequest(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 999 }),
      ],
    });
    mockGetMovie.mockResolvedValueOnce({
      id: 999,
      title: "Mystery Movie",
      originalTitle: "",
      posterPath: "/abc.jpg",
      backdropPath: null,
      overview: "",
      releaseDate: "2025-06-15",
    });

    const body = await expectJson<{
      requests: { title: string; year: number; posterUrl: string; mediaItem: unknown }[];
    }>(await callRouteWithParams(GET, { userKey: "alice" }), 200);

    expect(body.requests[0].title).toBe("Mystery Movie");
    expect(body.requests[0].year).toBe(2025);
    expect(body.requests[0].mediaItem).toBeNull();
    expect(body.requests[0].posterUrl).toContain("image.tmdb.org");
    expect(body.requests[0].posterUrl).toContain("/abc.jpg");
    expect(mockGetMovie).toHaveBeenCalledWith(999);
  });

  it("correlates watch status from WatchHistory for movies", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Inception" });
    const prisma = getTestPrisma();
    await prisma.mediaItem.update({
      where: { id: movie.id },
      data: { dedupKey: "inception-dedup" },
    });
    await createTestExternalId(movie.id, "TMDB", "27205");
    await prisma.watchHistory.create({
      data: { mediaItemId: movie.id, mediaServerId: server.id, serverUsername: "alice" },
    });

    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 1 },
      results: [
        makeRequest(1, "movie", { id: 1, username: "alice", plexUsername: "alice" }, { tmdbId: 27205 }),
      ],
    });

    const body = await expectJson<{
      requests: { watch: { watched: boolean; correlatable: boolean } }[];
    }>(await callRouteWithParams(GET, { userKey: "alice" }), 200);

    expect(body.requests[0].watch.correlatable).toBe(true);
    expect(body.requests[0].watch.watched).toBe(true);
  });

  it("returns 4k flag and status fields on requests", async () => {
    const user = await createTestUser();
    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    mockGetRequests.mockResolvedValueOnce({
      pageInfo: { page: 1, pages: 1, results: 1 },
      results: [
        makeRequest(
          1,
          "movie",
          { id: 1, username: "alice", plexUsername: "alice" },
          { tmdbId: 100, status: 5 },
          { is4k: true, status: 2 }
        ),
      ],
    });

    const body = await expectJson<{
      requests: { is4k: boolean; status: number; mediaStatus: number }[];
    }>(await callRouteWithParams(GET, { userKey: "alice" }), 200);

    expect(body.requests[0].is4k).toBe(true);
    expect(body.requests[0].status).toBe(2);
    expect(body.requests[0].mediaStatus).toBe(5);
  });
});
