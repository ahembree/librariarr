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
} from "../../setup/test-helpers";

// Redirect prisma to test database — MUST come before route imports
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

// Suppress logger DB writes
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/media/stats/timeline/route";

interface TimelineBody {
  points: { date: string; total: number }[];
  series: string[];
}

const BASE = "/api/media/stats/timeline";

describe("GET /api/media/stats/timeline", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function authedUser() {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    return user;
  }

  it("returns 401 when not authenticated", async () => {
    const response = await callRoute(GET, { url: `${BASE}?dateField=addedAt` });
    expect(await expectJson(response, 401)).toEqual({ error: "Unauthorized" });
  });

  it("returns 400 for a missing or invalid dateField", async () => {
    await authedUser();
    expect(await expectJson(await callRoute(GET, { url: BASE }), 400)).toEqual({
      error: "Invalid or missing dateField",
    });
    expect(
      await expectJson(await callRoute(GET, { url: `${BASE}?dateField=createdAt` }), 400),
    ).toEqual({ error: "Invalid or missing dateField" });
  });

  it("returns 400 for an invalid bin", async () => {
    await authedUser();
    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&bin=decade`,
    });
    expect(await expectJson(response, 400)).toEqual({ error: "Invalid bin" });
  });

  it("returns 400 for an invalid measure", async () => {
    await authedUser();
    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&measure=bytes`,
    });
    expect(await expectJson(response, 400)).toEqual({ error: "Invalid measure" });
  });

  // The type used to be spliced into the SQL as a quote-doubled literal; it is
  // a bound parameter now, and anything but a library type is refused first.
  it.each(["EPISODE", "MOVIE' OR '1'='1", "movie"])("returns 400 for the type %j", async (type) => {
    await authedUser();
    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&type=${encodeURIComponent(type)}`,
    });
    expect(await expectJson(response, 400)).toEqual({ error: "Invalid type" });
  });

  it("returns empty points when the user has no servers", async () => {
    await authedUser();
    const response = await callRoute(GET, { url: `${BASE}?dateField=addedAt` });
    const body = await expectJson<TimelineBody>(response, 200);
    expect(body.points).toEqual([]);
    expect(body.series).toEqual([]);
  });

  it("buckets item counts by month and fills gaps", async () => {
    const user = await authedUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id);
    await createTestMediaItem(library.id, { addedAt: new Date("2024-01-15T12:00:00Z") });
    await createTestMediaItem(library.id, { addedAt: new Date("2024-01-20T12:00:00Z") });
    // Gap: nothing added in February
    await createTestMediaItem(library.id, { addedAt: new Date("2024-03-10T12:00:00Z") });

    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&bin=month`,
    });
    const body = await expectJson<TimelineBody>(response, 200);
    expect(body.points).toEqual([
      { date: "2024-01", total: 2 },
      { date: "2024-02", total: 0 },
      { date: "2024-03", total: 1 },
    ]);
  });

  it("sums file sizes per bucket when measure=size", async () => {
    const user = await authedUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id);
    await createTestMediaItem(library.id, {
      addedAt: new Date("2024-01-15T12:00:00Z"),
      fileSize: 100n,
    });
    await createTestMediaItem(library.id, {
      addedAt: new Date("2024-01-20T12:00:00Z"),
      fileSize: 200n,
    });
    await createTestMediaItem(library.id, {
      addedAt: new Date("2024-02-10T12:00:00Z"),
      fileSize: 50n,
    });

    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&bin=month&measure=size`,
    });
    const body = await expectJson<TimelineBody>(response, 200);
    expect(body.points).toEqual([
      { date: "2024-01", total: 300 },
      { date: "2024-02", total: 50 },
    ]);
  });

  it("filters by media type", async () => {
    const user = await authedUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const shows = await createTestLibrary(server.id, { type: "SERIES" });
    await createTestMediaItem(library.id, {
      addedAt: new Date("2024-01-15T12:00:00Z"),
      type: "MOVIE",
    });
    await createTestMediaItem(shows.id, {
      addedAt: new Date("2024-01-16T12:00:00Z"),
      type: "SERIES",
      parentTitle: "Show",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&bin=month&type=MOVIE`,
    });
    const body = await expectJson<TimelineBody>(response, 200);
    expect(body.points).toEqual([{ date: "2024-01", total: 1 }]);
  });

  it("returns 404 for a serverId that names no server", async () => {
    const user = await authedUser();
    await createTestServer(user.id);

    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&serverId=nonexistent`,
    });
    expect(await expectJson(response, 404)).toEqual({ error: "Server not found" });
  });

  it("scopes results to the requested server", async () => {
    const user = await authedUser();
    const serverA = await createTestServer(user.id, { name: "A" });
    const serverB = await createTestServer(user.id, { name: "B" });
    const libraryA = await createTestLibrary(serverA.id);
    const libraryB = await createTestLibrary(serverB.id);
    await createTestMediaItem(libraryA.id, { addedAt: new Date("2024-01-15T12:00:00Z") });
    await createTestMediaItem(libraryB.id, { addedAt: new Date("2024-01-16T12:00:00Z") });
    await createTestMediaItem(libraryB.id, { addedAt: new Date("2024-01-17T12:00:00Z") });

    const response = await callRoute(GET, {
      url: `${BASE}?dateField=addedAt&bin=month&serverId=${serverB.id}`,
    });
    const body = await expectJson<TimelineBody>(response, 200);
    expect(body.points).toEqual([{ date: "2024-01", total: 2 }]);
  });

  it("refuses a breakdown it cannot colour by instead of returning a plain total", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    for (const [breakdown, label] of [
      ["genre", "Genre"],
      ["countries", "Countries"],
      ["audioLanguage", "Audio Language"],
      ["subtitleLanguage", "Subtitle Language"],
      ["lastPlayedAt", "Last Played"],
    ]) {
      const response = await callRoute(GET, {
        url: "/api/media/stats/timeline",
        searchParams: { dateField: "addedAt", breakdown },
      });
      // Refused as uncolourable — not as an unknown dimension.
      expect(await expectJson(response, 400), breakdown).toEqual({
        error: `Cannot break a timeline down by ${label}`,
      });
    }
  });

  // The dialog offers Day and Week for every date field. Gap-filling a range
  // wider than its bucket limit used to stop the walk part-way and return only
  // the buckets walked, dropping every point after them — the newest first.
  it.each([
    ["day", "1990-06-15T00:00:00Z", "2024-06-15T00:00:00Z"],
    ["week", "1927-01-10T00:00:00Z", "2024-06-12T00:00:00Z"],
  ])("keeps every release on a %s timeline wider than the gap-fill limit", async (bin, oldest, newest) => {
    const user = await authedUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id);
    for (const date of [oldest, newest]) {
      const item = await createTestMediaItem(library.id);
      await getTestPrisma().mediaItem.update({
        where: { id: item.id },
        data: { originallyAvailableAt: new Date(date) },
      });
    }

    const body = await expectJson<TimelineBody>(
      await callRoute(GET, { url: `${BASE}?dateField=originallyAvailableAt&bin=${bin}` }),
      200,
    );
    expect(body.points.reduce((sum, p) => sum + p.total, 0)).toBe(2);
    expect(body.points.at(-1)?.total).toBe(1);
  });

  it("keeps a bucket the gap-fill walk cannot reproduce instead of hiding it behind zeros", async () => {
    // `new Date(50, 0, 1)` is 1950, so the walk never produces the label
    // "0050" a year-50 release date buckets into — a bad date in the server's
    // metadata — and filling around it dropped that point.
    const user = await authedUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id);
    for (const date of ["0050-06-01T00:00:00Z", "2020-06-01T00:00:00Z"]) {
      const item = await createTestMediaItem(library.id);
      await getTestPrisma().mediaItem.update({
        where: { id: item.id },
        data: { originallyAvailableAt: new Date(date) },
      });
    }

    const body = await expectJson<TimelineBody>(
      await callRoute(GET, { url: `${BASE}?dateField=originallyAvailableAt&bin=year` }),
      200,
    );
    expect(body.points).toEqual([
      { date: "0050", total: 1 },
      { date: "2020", total: 1 },
    ]);
  });

  it("leaves out the types a breakdown does not apply to (excludeTypes)", async () => {
    // A music track has no video codec or resolution: charted, every track
    // added in a month became one large "Unknown" series beside the films.
    const user = await authedUser();
    const server = await createTestServer(user.id);
    const movies = await createTestLibrary(server.id, { type: "MOVIE" });
    const music = await createTestLibrary(server.id, { type: "MUSIC" });
    const addedAt = new Date("2024-05-10T12:00:00Z");
    await createTestMediaItem(movies.id, { videoCodec: "h264", resolution: "1080", addedAt });
    for (let i = 0; i < 3; i++) {
      const track = await createTestMediaItem(music.id, { type: "MUSIC", title: `Track ${i}`, addedAt });
      await getTestPrisma().mediaItem.update({
        where: { id: track.id },
        data: { videoCodec: null, resolution: null },
      });
    }

    // direct and value_map — the breakdown categories video dimensions use.
    for (const [breakdown, value] of [["videoCodec", "h264"], ["resolution", "1080P"]]) {
      const body = await expectJson<TimelineBody>(
        await callRoute(GET, { url: `${BASE}?dateField=addedAt&breakdown=${breakdown}` }),
        200,
      );
      expect(body.series, breakdown).toEqual([value]);
      expect(body.points.map((p) => p.total), breakdown).toEqual([1]);
    }

    // A breakdown that applies to music still counts the tracks.
    const audio = await expectJson<TimelineBody>(
      await callRoute(GET, { url: `${BASE}?dateField=addedAt&breakdown=audioCodec` }),
      200,
    );
    expect(audio.points.map((p) => p.total)).toEqual([4]);
  });
});
