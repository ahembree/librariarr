import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import {
  createTestUser,
  createTestApiKey,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  expectJson,
} from "../../setup/test-helpers";
import { callV1 } from "./v1-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/v1/stats/route";
import { appCache } from "@/lib/cache/memory-cache";

interface StatsBody {
  movieCount: number;
  seriesCount: number;
  musicCount: number;
  episodeCount: number;
  totalSize: string;
  movieSize: string;
  seriesSize: string;
  musicSize: string;
  movieDuration: number;
  qualityBreakdown: unknown[];
  topMovies: unknown[];
  genreBreakdown: unknown[];
}

const URL_STATS = "/api/v1/stats";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  // The route shares its cache entry with /api/media/stats; a stale entry from
  // a previous test would mask a wrong query here.
  appCache.clear();
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("GET /api/v1/stats", () => {
  it("returns the all-zero payload when no servers are connected", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);

    const body = await expectJson<StatsBody>(await callV1(GET, { url: URL_STATS, key: raw }));
    expect(body.movieCount).toBe(0);
    expect(body.episodeCount).toBe(0);
    expect(body.totalSize).toBe("0");
    expect(body.movieDuration).toBe(0);
    expect(body.qualityBreakdown).toEqual([]);
    expect(body.topMovies).toEqual([]);
    expect(body.genreBreakdown).toEqual([]);
  });

  it("counts the user's media and serializes every size as a string", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const server = await createTestServer(user.id);
    const movies = await createTestLibrary(server.id, { type: "MOVIE" });
    const tv = await createTestLibrary(server.id, { type: "SERIES" });
    await createTestMediaItem(movies.id, { title: "A", fileSize: BigInt(1000) });
    await createTestMediaItem(movies.id, { title: "B", fileSize: BigInt(2000) });
    await createTestMediaItem(tv.id, {
      title: "S01E01",
      type: "SERIES",
      parentTitle: "Show",
      seasonNumber: 1,
      fileSize: BigInt(500),
    });

    const body = await expectJson<StatsBody>(await callV1(GET, { url: URL_STATS, key: raw }));
    expect(body.movieCount).toBe(2);
    expect(body.episodeCount).toBe(1);
    expect(body.seriesCount).toBe(1);
    expect(body.totalSize).toBe("3500");
    expect(typeof body.totalSize).toBe("string");
    expect(typeof body.movieSize).toBe("string");
    expect(typeof body.seriesSize).toBe("string");
    expect(typeof body.musicSize).toBe("string");
    expect(body.movieSize).toBe("3000");
  });

  it("scopes to a single server when serverId is given", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const one = await createTestServer(user.id, { name: "One" });
    const two = await createTestServer(user.id, { name: "Two" });
    const libOne = await createTestLibrary(one.id, { type: "MOVIE" });
    const libTwo = await createTestLibrary(two.id, { type: "MOVIE" });
    await createTestMediaItem(libOne.id, { title: "Only On One" });
    await createTestMediaItem(libTwo.id, { title: "A" });
    await createTestMediaItem(libTwo.id, { title: "B" });

    const body = await expectJson<StatsBody>(
      await callV1(GET, { url: URL_STATS, key: raw, searchParams: { serverId: two.id } }),
    );
    expect(body.movieCount).toBe(2);
  });

  it("404s on an unknown serverId", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    await createTestServer(user.id);

    const body = await expectJson<{ error: string }>(
      await callV1(GET, { url: URL_STATS, key: raw, searchParams: { serverId: "no-such-server" } }),
      404,
    );
    expect(body.error).toBe("Server not found");
  });

  it("404s on a serverId that belongs to another user", async () => {
    const owner = await createTestUser({ plexId: "owner", username: "owner" });
    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const { raw } = await createTestApiKey(owner.id);
    await createTestServer(owner.id, { name: "Mine" });
    const theirs = await createTestServer(stranger.id, { name: "Theirs" });

    await expectJson(
      await callV1(GET, { url: URL_STATS, key: raw, searchParams: { serverId: theirs.id } }),
      404,
    );
  });

  it("never counts another user's media", async () => {
    const owner = await createTestUser({ plexId: "owner", username: "owner" });
    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const { raw } = await createTestApiKey(owner.id);
    const mine = await createTestServer(owner.id, { name: "Mine" });
    const theirs = await createTestServer(stranger.id, { name: "Theirs" });
    const mineLib = await createTestLibrary(mine.id, { type: "MOVIE" });
    const theirsLib = await createTestLibrary(theirs.id, { type: "MOVIE" });
    await createTestMediaItem(mineLib.id, { title: "Mine", fileSize: BigInt(10) });
    await createTestMediaItem(theirsLib.id, { title: "Theirs", fileSize: BigInt(9999) });
    await createTestMediaItem(theirsLib.id, { title: "Theirs 2", fileSize: BigInt(9999) });

    const body = await expectJson<StatsBody>(await callV1(GET, { url: URL_STATS, key: raw }));
    expect(body.movieCount).toBe(1);
    expect(body.totalSize).toBe("10");
  });

  it("shares one cache entry with the internal stats route", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const server = await createTestServer(user.id);
    const movies = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(movies.id, { title: "A" });

    const first = await expectJson<StatsBody>(await callV1(GET, { url: URL_STATS, key: raw }));
    expect(first.movieCount).toBe(1);
    expect(appCache.get(`stats:${user.id}:all:raw`)).toBeTruthy();

    // Within the 60s TTL the second call is served from that entry, so a row
    // inserted in between is deliberately not reflected.
    await createTestMediaItem(movies.id, { title: "B" });
    const second = await expectJson<StatsBody>(await callV1(GET, { url: URL_STATS, key: raw }));
    expect(second.movieCount).toBe(1);
  });
});
