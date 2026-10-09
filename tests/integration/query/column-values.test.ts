import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestMediaStream,
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

import { POST } from "@/app/api/query/column-values/route";
import { appCache } from "@/lib/cache/memory-cache";

type Body = { values: Record<string, Record<string, unknown>>; warnings: string[] };

describe("POST /api/query/column-values", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const res = await callRoute(POST, { url: "/api/query/column-values", method: "POST", body: { items: [], fields: ["studio"] } });
    await expectJson(res, 401);
  });

  it("returns 400 on an invalid body", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const res = await callRoute(POST, { url: "/api/query/column-values", method: "POST", body: { items: [], fields: [] } });
    await expectJson(res, 400);
  });

  it("returns values for a movie's criteria", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(lib.id, { type: "MOVIE", title: "M", studio: "A24", genres: ["Drama"] });
    await createTestMediaStream(movie.id, { streamType: 2, language: "English", codec: "eac3" });
    await createTestExternalId(movie.id, "TMDB", "603");
    await getTestPrisma().watchHistory.create({
      data: { mediaItemId: movie.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: new Date() },
    });

    const res = await callRoute(POST, {
      url: "/api/query/column-values",
      method: "POST",
      body: {
        items: [{ id: movie.id }],
        fields: ["studio", "genre", "audioLanguage", "hasExternalId", "watchedByUser", "serverCount", "notAField"],
      },
    });
    const body = await expectJson<Body>(res, 200);
    expect(body.values[movie.id]).toEqual({
      studio: "A24",
      genre: ["Drama"],
      audioLanguage: ["English"],
      hasExternalId: ["TMDB:603"],
      watchedByUser: ["alice"],
      serverCount: 1,
    });
  });

  it("answers a grouped series row from the show's aggregate", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const ids: string[] = [];
    for (let e = 1; e <= 4; e++) {
      const ep = await createTestMediaItem(lib.id, {
        type: "SERIES", title: `E${e}`, parentTitle: "Show", seriesKey: "title:show",
        seasonNumber: 1, episodeNumber: e, playCount: e === 1 ? 2 : 0,
      });
      await getTestPrisma().mediaItem.update({ where: { id: ep.id }, data: { videoBitrate: 5000 } });
      ids.push(ep.id);
    }

    const res = await callRoute(POST, {
      url: "/api/query/column-values",
      method: "POST",
      body: {
        items: [{ id: ids[0], grouped: true }, { id: ids[1] }],
        fields: ["availableEpisodeCount", "watchedEpisodePercentage", "videoBitrate"],
      },
    });
    const body = await expectJson<Body>(res, 200);
    expect(body.values[ids[0]]).toEqual({ availableEpisodeCount: 4, watchedEpisodePercentage: 25, videoBitrate: null });
    // An episode row is not a show: no aggregate, but its own detail.
    expect(body.values[ids[1]]).toEqual({ availableEpisodeCount: null, watchedEpisodePercentage: null, videoBitrate: 5000 });
  });

  it("returns nothing for another server than the query's selection, or for a disabled server", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const a = await createTestServer(user.id, { name: "A", machineId: "a" });
    const b = await createTestServer(user.id, { name: "B", machineId: "b" });
    const off = await createTestServer(user.id, { name: "Off", machineId: "off", enabled: false });
    const ma = await createTestMediaItem((await createTestLibrary(a.id, { key: "a" })).id, { type: "MOVIE", studio: "X" });
    const mb = await createTestMediaItem((await createTestLibrary(b.id, { key: "b" })).id, { type: "MOVIE", studio: "Y" });
    const mo = await createTestMediaItem((await createTestLibrary(off.id, { key: "o" })).id, { type: "MOVIE", studio: "Z" });

    const res = await callRoute(POST, {
      url: "/api/query/column-values",
      method: "POST",
      body: { items: [{ id: ma.id }, { id: mb.id }, { id: mo.id }], fields: ["studio"], serverIds: [a.id] },
    });
    const body = await expectJson<Body>(res, 200);
    expect(Object.keys(body.values)).toEqual([ma.id]);
  });

  it("warns instead of guessing when an Arr column has no Arr server selected", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const server = await createTestServer(user.id);
    const movie = await createTestMediaItem((await createTestLibrary(server.id)).id, { type: "MOVIE" });

    const res = await callRoute(POST, {
      url: "/api/query/column-values",
      method: "POST",
      body: { items: [{ id: movie.id }], fields: ["foundInArr", "arrTag"] },
    });
    const body = await expectJson<Body>(res, 200);
    expect(body.values[movie.id]).toEqual({ foundInArr: null, arrTag: null });
    expect(body.warnings).toHaveLength(1);
  });

  it("does not read another user's items", async () => {
    const owner = await createTestUser({ plexId: "owner" });
    const server = await createTestServer(owner.id);
    const movie = await createTestMediaItem((await createTestLibrary(server.id)).id, { type: "MOVIE", studio: "A24" });
    const other = await createTestUser({ plexId: "other" });
    setMockSession({ isLoggedIn: true, userId: other.id });

    const res = await callRoute(POST, {
      url: "/api/query/column-values",
      method: "POST",
      body: { items: [{ id: movie.id }], fields: ["studio"] },
    });
    const body = await expectJson<Body>(res, 200);
    expect(body.values).toEqual({});
  });
});
