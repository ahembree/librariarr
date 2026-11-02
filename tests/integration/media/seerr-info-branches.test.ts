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

const m = vi.hoisted(() => ({
  getMovie: vi.fn(),
  getTvShow: vi.fn(),
  getRequests: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: m.warn, error: m.error },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The real bound, shortened so a hung instance is given up on in milliseconds.
vi.mock("@/lib/api/bounded", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/bounded")>();
  return {
    withTimeout: <T,>(work: Promise<T>, _ms: number, onTimeout?: () => void) =>
      actual.withTimeout(work, 50, onTimeout),
  };
});

vi.mock("@/lib/seerr/seerr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seerr/seerr-client")>()),
  SeerrClient: vi.fn().mockImplementation(function (url: string) {
    return {
      getMovie: (id: number, opts?: { signal?: AbortSignal }) => m.getMovie(url, id, opts),
      getTvShow: (id: number, opts?: { signal?: AbortSignal }) => m.getTvShow(url, id, opts),
      getRequests: (params: unknown) => m.getRequests(url, params),
    };
  }),
}));

import { GET } from "@/app/api/media/[id]/seerr-info/route";

type Match = {
  instanceName: string;
  matchedVia: string;
  externalId: string;
  seerrUrl: string | null;
  mediaStatus: number | null;
  requests: { id: number; requestedBy: string }[];
};

function req(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: 2,
    is4k: false,
    requestedBy: { id: 1, username: "Alice", plexUsername: "alice", email: "a@test.com" },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
    ...extra,
  };
}

describe("GET /api/media/[id]/seerr-info — series, statuses, timeouts", () => {
  let userId: string;
  let libraryId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    m.getMovie.mockReset();
    m.getTvShow.mockReset();
    m.getRequests.mockReset();
    userId = (await createTestUser()).id;
    setMockSession({ userId, isLoggedIn: true });
    const server = await createTestServer(userId);
    libraryId = (await createTestLibrary(server.id, { type: "SERIES" })).id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function episode(ids: Array<[string, string]>) {
    const ep = await createTestMediaItem(libraryId, {
      type: "SERIES", title: "Pilot", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1,
    });
    for (const [source, value] of ids) await createTestExternalId(ep.id, source, value);
    return ep;
  }

  async function matches(id: string) {
    return (await expectJson<{ matches: Match[] }>(await callRouteWithParams(GET, { id }))).matches;
  }

  it("returns no matches for an item with neither TMDB nor TVDB id", async () => {
    const ep = await episode([["IMDB", "tt1"]]);
    await createTestSeerrInstance(userId);
    expect(await matches(ep.id)).toEqual([]);
    expect(m.getTvShow).not.toHaveBeenCalled();
  });

  it("uses the TV endpoint for a series with a TMDB id and reports it as matched via TVDB when it has one", async () => {
    const ep = await episode([["TMDB", "1396"], ["TVDB", "81189"]]);
    const inst = await createTestSeerrInstance(userId, { url: "http://seerr.lan:5055/" });
    m.getTvShow.mockResolvedValue({ mediaInfo: { tmdbId: 1396, status: 3, requests: [req(7)] } });
    const [match] = await matches(ep.id);
    expect(match).toEqual(expect.objectContaining({
      matchedVia: "TVDB",
      externalId: "81189",
      mediaStatus: 3,
      // Trailing slash trimmed.
      seerrUrl: "http://seerr.lan:5055/tv/1396",
    }));
    expect(match.requests).toEqual([expect.objectContaining({ id: 7 })]);
    expect(m.getTvShow).toHaveBeenCalledWith(inst.url, 1396, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(m.getMovie).not.toHaveBeenCalled();
    expect(m.getRequests).not.toHaveBeenCalled();
  });

  it("matches a TMDB-only series via TMDB", async () => {
    const ep = await episode([["TMDB", "1396"]]);
    await createTestSeerrInstance(userId);
    m.getTvShow.mockResolvedValue({ mediaInfo: { status: 5, requests: [req(1)] } });
    const [match] = await matches(ep.id);
    expect(match.matchedVia).toBe("TMDB");
    expect(match.externalId).toBe("1396");
  });

  it("returns nothing when the media has no requests or no media info", async () => {
    const ep = await episode([["TMDB", "1396"]]);
    await createTestSeerrInstance(userId, { name: "A" });
    await createTestSeerrInstance(userId, { name: "B" });
    m.getTvShow
      .mockResolvedValueOnce({ mediaInfo: { status: 5, requests: [] } })
      .mockResolvedValueOnce({});
    expect(await matches(ep.id)).toEqual([]);
    // Both instances were asked; neither answer is a match.
    expect(m.getTvShow).toHaveBeenCalledTimes(2);
  });

  it("skips a non-numeric TMDB id without calling Seerr", async () => {
    const movieLib = (await createTestLibrary((await createTestServer(userId)).id, { type: "MOVIE" })).id;
    const movie = await createTestMediaItem(movieLib, { type: "MOVIE" });
    await createTestExternalId(movie.id, "TMDB", "not-a-number");
    await createTestSeerrInstance(userId);
    expect(await matches(movie.id)).toEqual([]);
    expect(m.getMovie).not.toHaveBeenCalled();
  });

  it("falls back to the plain status when every request is 4K but no 4K status exists", async () => {
    const movieLib = (await createTestLibrary((await createTestServer(userId)).id, { type: "MOVIE" })).id;
    const movie = await createTestMediaItem(movieLib, { type: "MOVIE" });
    await createTestExternalId(movie.id, "TMDB", "603");
    await createTestSeerrInstance(userId);
    m.getMovie.mockResolvedValue({ mediaInfo: { status: 2, requests: [req(1, { is4k: true })] } });
    const [match] = await matches(movie.id);
    expect(match.mediaStatus).toBe(2);
  });

  it("reports a null status when the media carries none", async () => {
    const movieLib = (await createTestLibrary((await createTestServer(userId)).id, { type: "MOVIE" })).id;
    const movie = await createTestMediaItem(movieLib, { type: "MOVIE" });
    await createTestExternalId(movie.id, "TMDB", "603");
    await createTestSeerrInstance(userId);
    m.getMovie.mockResolvedValue({ mediaInfo: { requests: [req(1)] } });
    const [match] = await matches(movie.id);
    expect(match.mediaStatus).toBeNull();
  });

  it("gives a TVDB-only match no link when the Seerr media has no TMDB id", async () => {
    const ep = await episode([["TVDB", "81189"]]);
    await createTestSeerrInstance(userId);
    m.getRequests.mockResolvedValue({
      pageInfo: { pages: 1, page: 1, results: 2 },
      results: [
        req(3, { type: "tv", media: { tvdbId: 81189, status: 4 } }),
        req(4, { type: "tv" }),
      ],
    });
    const [match] = await matches(ep.id);
    expect(match.seerrUrl).toBeNull();
    expect(match.mediaStatus).toBe(4);
    expect(match.requests.map((r) => r.id)).toEqual([3]);
  });

  it("gives up on an instance that does not answer in time and keeps the others", async () => {
    const movieLib = (await createTestLibrary((await createTestServer(userId)).id, { type: "MOVIE" })).id;
    const movie = await createTestMediaItem(movieLib, { type: "MOVIE" });
    await createTestExternalId(movie.id, "TMDB", "603");
    await createTestSeerrInstance(userId, { name: "Slow", url: "http://slow:5055" });
    await createTestSeerrInstance(userId, { name: "Fast", url: "http://fast:5055" });
    let abortedSignal: AbortSignal | undefined;
    m.getMovie.mockImplementation((url: string, _id: number, opts?: { signal?: AbortSignal }) => {
      if (url === "http://fast:5055") return Promise.resolve({ mediaInfo: { status: 5, requests: [req(9)] } });
      abortedSignal = opts?.signal;
      // Hangs until the bound aborts it, then rejects like axios would.
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("canceled")));
      });
    });

    const result = await matches(movie.id);
    expect(result.map((r) => r.instanceName)).toEqual(["Fast"]);
    expect(abortedSignal?.aborted).toBe(true);
    expect(m.warn).toHaveBeenCalledWith("Media", expect.stringContaining("Slow did not answer"));
    // The cancellation the bound caused is not logged as a failure (flush the
    // rejection the abort triggered before looking).
    await new Promise((r) => setImmediate(r));
    expect(m.error).not.toHaveBeenCalled();
  });

  it("does not query a disabled instance", async () => {
    const movieLib = (await createTestLibrary((await createTestServer(userId)).id, { type: "MOVIE" })).id;
    const movie = await createTestMediaItem(movieLib, { type: "MOVIE" });
    await createTestExternalId(movie.id, "TMDB", "603");
    const inst = await createTestSeerrInstance(userId);
    await getTestPrisma().seerrInstance.update({ where: { id: inst.id }, data: { enabled: false } });
    expect(await matches(movie.id)).toEqual([]);
    expect(m.getMovie).not.toHaveBeenCalled();
  });
});
