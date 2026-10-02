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
  createTestExternalId,
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

const mockGetMovie = vi.fn();
const mockGetTvShow = vi.fn();
const mockGetRequests = vi.fn();

vi.mock("@/lib/seerr/seerr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seerr/seerr-client")>()),
  SeerrClient: vi.fn().mockImplementation(function (url: string) {
    return {
      getMovie: (id: number) => mockGetMovie(url, id),
      getTvShow: (id: number) => mockGetTvShow(url, id),
      getRequests: (params: unknown) => mockGetRequests(url, params),
    };
  }),
}));

import { GET } from "@/app/api/media/[id]/seerr-info/route";

function seerrRequest(id: number, overrides: { status?: number; is4k?: boolean; tvdbId?: number | null; tmdbId?: number; type?: "movie" | "tv"; media?: Record<string, unknown> } = {}) {
  return {
    id,
    type: overrides.type ?? "movie",
    status: overrides.status ?? 5,
    is4k: overrides.is4k ?? false,
    media: { tmdbId: overrides.tmdbId ?? 603, tvdbId: overrides.tvdbId ?? null, status: 5, status4k: 1, ...overrides.media },
    requestedBy: { id: 1, username: "Alice", plexUsername: "alice", email: "a@test.com" },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
  };
}

async function movieWith(userId: string, ids: Array<[string, string]>) {
  const server = await createTestServer(userId);
  const library = await createTestLibrary(server.id, { type: "MOVIE" });
  const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "The Matrix" });
  for (const [source, value] of ids) await createTestExternalId(movie.id, source, value);
  return movie;
}

describe("GET /api/media/[id]/seerr-info", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    mockGetMovie.mockReset();
    mockGetTvShow.mockReset();
    mockGetRequests.mockReset();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const res = await callRouteWithParams(GET, { id: "x" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown item and 403 for another user's item", async () => {
    const owner = await createTestUser({ plexId: "owner" });
    const movie = await movieWith(owner.id, [["TMDB", "603"]]);
    const other = await createTestUser({ plexId: "other" });
    setMockSession({ userId: other.id, plexToken: "tok", isLoggedIn: true });

    expect((await callRouteWithParams(GET, { id: "missing" })).status).toBe(404);
    expect((await callRouteWithParams(GET, { id: movie.id })).status).toBe(403);
  });

  it("returns the requests for a movie via the TMDB fast path", async () => {
    const user = await createTestUser();
    const movie = await movieWith(user.id, [["TMDB", "603"]]);
    await createTestSeerrInstance(user.id, { name: "Seerr", url: "http://seerr:5055" });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    mockGetMovie.mockResolvedValue({ mediaInfo: { status: 5, status4k: 1, requests: [seerrRequest(1)] } });

    const body = await expectJson<{
      matches: Array<{ instanceName: string; matchedVia: string; externalId: string; seerrUrl: string; mediaStatus: number; requests: Array<{ requestedBy: string; status: number }> }>;
    }>(await callRouteWithParams(GET, { id: movie.id }), 200);

    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({
      instanceName: "Seerr",
      matchedVia: "TMDB",
      externalId: "603",
      seerrUrl: "http://seerr:5055/movie/603",
      mediaStatus: 5,
    });
    expect(body.matches[0].requests).toEqual([expect.objectContaining({ requestedBy: "alice", status: 5 })]);
    expect(mockGetMovie).toHaveBeenCalledWith("http://seerr:5055", 603);
  });

  it("builds the Open-in-Seerr link from the external URL when one is set", async () => {
    const user = await createTestUser();
    const movie = await movieWith(user.id, [["TMDB", "603"]]);
    const instance = await createTestSeerrInstance(user.id, { url: "http://seerr:5055" });
    await getTestPrisma().seerrInstance.update({
      where: { id: instance.id },
      data: { externalUrl: "https://requests.example.com" },
    });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    mockGetMovie.mockResolvedValue({ mediaInfo: { status: 5, requests: [seerrRequest(1)] } });

    const body = await expectJson<{ matches: Array<{ seerrUrl: string }> }>(
      await callRouteWithParams(GET, { id: movie.id }),
      200,
    );
    expect(body.matches[0].seerrUrl).toBe("https://requests.example.com/movie/603");
    // The API itself is still called on the connection URL.
    expect(mockGetMovie).toHaveBeenCalledWith("http://seerr:5055", 603);
  });

  it("reports the 4K copy's status when every request is a 4K one", async () => {
    const user = await createTestUser();
    const movie = await movieWith(user.id, [["TMDB", "603"]]);
    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    mockGetMovie.mockResolvedValue({
      mediaInfo: { status: 1, status4k: 3, requests: [seerrRequest(1, { status: 2, is4k: true })] },
    });

    const body = await expectJson<{ matches: Array<{ mediaStatus: number }> }>(
      await callRouteWithParams(GET, { id: movie.id }),
      200,
    );
    expect(body.matches[0].mediaStatus).toBe(3);
  });

  it("walks the request list for a TVDB-only series", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const ep = await createTestMediaItem(library.id, {
      type: "SERIES", title: "Pilot", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1,
    });
    await createTestExternalId(ep.id, "TVDB", "81189");
    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    mockGetRequests.mockResolvedValue({
      results: [
        seerrRequest(2, { type: "tv", tmdbId: 1396, tvdbId: 81189, media: { status: 4 } }),
        seerrRequest(1, { type: "tv", tmdbId: 999, tvdbId: 5 }),
      ],
    });

    const body = await expectJson<{ matches: Array<{ matchedVia: string; externalId: string; mediaStatus: number; requests: unknown[]; seerrUrl: string | null }> }>(
      await callRouteWithParams(GET, { id: ep.id }),
      200,
    );

    expect(body.matches).toHaveLength(1);
    // Seerr pages are keyed by TMDB id; the matched Seerr media carries one
    // even though the library copy only knows the TVDB id.
    expect(body.matches[0]).toMatchObject({
      matchedVia: "TVDB",
      externalId: "81189",
      mediaStatus: 4,
      seerrUrl: "http://seerr.test:5055/tv/1396",
    });
    expect(body.matches[0].requests).toHaveLength(1);
    expect(mockGetTvShow).not.toHaveBeenCalled();
  });

  it("does not walk the request list for a movie with no TMDB id", async () => {
    // A movie request can only match by TMDB id — the walk could never succeed.
    const user = await createTestUser();
    const movie = await movieWith(user.id, [["TVDB", "123"]]);
    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{ matches: unknown[] }>(await callRouteWithParams(GET, { id: movie.id }), 200);

    expect(body.matches).toEqual([]);
    expect(mockGetRequests).not.toHaveBeenCalled();
  });

  it("returns empty for music without querying Seerr", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MUSIC" });
    const track = await createTestMediaItem(library.id, { type: "MUSIC", title: "Song" });
    await createTestSeerrInstance(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{ matches: unknown[] }>(await callRouteWithParams(GET, { id: track.id }), 200);
    expect(body.matches).toEqual([]);
    expect(mockGetMovie).not.toHaveBeenCalled();
  });

  it("skips a failing instance and still returns the healthy one", async () => {
    const user = await createTestUser();
    const movie = await movieWith(user.id, [["TMDB", "603"]]);
    await createTestSeerrInstance(user.id, { name: "Down", url: "http://down:5055" });
    await createTestSeerrInstance(user.id, { name: "Up", url: "http://up:5055" });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
    mockGetMovie.mockImplementation(async (url: string) => {
      if (url === "http://down:5055") throw new Error("Seerr unreachable");
      return { mediaInfo: { status: 5, requests: [seerrRequest(1)] } };
    });

    const body = await expectJson<{ matches: Array<{ instanceName: string }> }>(
      await callRouteWithParams(GET, { id: movie.id }),
      200,
    );
    expect(body.matches.map((m) => m.instanceName)).toEqual(["Up"]);
  });
});
