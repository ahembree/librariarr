/**
 * Server presence for a listing as long as a library, against the real
 * database. Postgres takes at most 32,767 bind parameters per statement, and
 * Prisma splits an over-long `in` list only for an unordered, unpaged
 * findMany: the presence lookup put every listed row's `dedupKey` into one
 * list of an ordered findMany, so with two servers and more than ~32.7k
 * canonical rows the Movies, Episodes and Tracks remainder request
 * (`limit=0&offset=100`) answered 500 and the pages showed only their first
 * 100 rows. The rows are bulk-inserted in SQL to keep this fast.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
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

import { getServerPresenceByDedupKey } from "@/lib/dedup/server-presence";
import { GET as moviesGet } from "@/app/api/media/movies/route";
import { GET as seriesGet } from "@/app/api/media/series/route";
import { GET as musicGet } from "@/app/api/media/music/route";
import { appCache } from "@/lib/cache/memory-cache";

const prisma = getTestPrisma();

/** More canonical rows than a statement takes bind parameters. */
const PAST_THE_LIMIT = 33_000;

type Kind = "MOVIE" | "SERIES" | "MUSIC";

/**
 * `count` rows of `kind` in `libraryId`, keyed `<kind>:<n>`, numbered from 1.
 * `prefix` keeps ids and rating keys apart per server; `createdAt` orders the
 * copies.
 */
async function bulkInsert(
  libraryId: string,
  kind: Kind,
  count: number,
  opts: { prefix: string; canonical: boolean; createdAt: Date },
) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "MediaItem" (id, "libraryId", "ratingKey", title, "titleSort", type,
       "parentTitle", "albumTitle", "seasonNumber", "episodeNumber", "seriesKey",
       "dedupKey", "dedupCanonical", "createdAt", "updatedAt")
     SELECT $2 || '-' || g, $1, $2 || '-rk-' || g, 'Item ' || lpad(g::text, 6, '0'),
       'Item ' || lpad(g::text, 6, '0'), k.kind::"LibraryType",
       CASE WHEN k.kind = 'MOVIE' THEN NULL ELSE 'Parent ' || (g / 100) END,
       CASE WHEN k.kind = 'MUSIC' THEN 'Album ' || (g / 10) ELSE NULL END,
       CASE WHEN k.kind = 'SERIES' THEN 1 ELSE NULL END,
       CASE WHEN k.kind = 'SERIES' THEN g ELSE NULL END,
       CASE WHEN k.kind = 'SERIES' THEN 'title:parent ' || (g / 100) ELSE NULL END,
       lower(k.kind) || ':' || g, $4, $5, $5
     FROM generate_series(1, $6::int) g, (SELECT $3::text AS kind) k`,
    libraryId,
    opts.prefix,
    kind,
    opts.canonical,
    opts.createdAt,
    count,
  );
}

/** One user, two servers each holding a copy of every row of `kind`. */
async function twoServerLibrary(kind: Kind) {
  const user = await createTestUser();
  const alpha = await createTestServer(user.id, { name: "Alpha" });
  const beta = await createTestServer(user.id, { name: "Beta" });
  const libA = await createTestLibrary(alpha.id, { type: kind });
  const libB = await createTestLibrary(beta.id, { type: kind });
  await bulkInsert(libA.id, kind, PAST_THE_LIMIT, {
    prefix: "a",
    canonical: true,
    createdAt: new Date("2024-01-01T00:00:00Z"),
  });
  await bulkInsert(libB.id, kind, PAST_THE_LIMIT, {
    prefix: "b",
    canonical: false,
    createdAt: new Date("2024-02-01T00:00:00Z"),
  });
  return { user, alpha, beta, libA, libB };
}

interface ListBody {
  items: Array<{ id: string; dedupKey: string; servers: Array<{ serverId: string; mediaItemId?: string }> }>;
  pagination: { hasMore: boolean };
}

describe("server presence past the bind-parameter limit", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("getServerPresenceByDedupKey answers for 33k keys across two servers, linking each server's oldest copy", async () => {
    const { alpha, beta, libB } = await twoServerLibrary("MOVIE");
    // A second, older copy of key 7 on Beta: Beta's badge links it, not the newer one.
    await bulkInsert(libB.id, "MOVIE", 1, {
      prefix: "b-old",
      canonical: false,
      createdAt: new Date("2023-01-01T00:00:00Z"),
    });
    await prisma.mediaItem.update({ where: { id: "b-old-1" }, data: { dedupKey: "movie:7" } });

    const keys = Array.from({ length: PAST_THE_LIMIT }, (_, i) => `movie:${i + 1}`);
    const map = await getServerPresenceByDedupKey(keys, [alpha.id, beta.id]);

    expect(map.size).toBe(PAST_THE_LIMIT);
    expect(map.get("movie:1")).toEqual([
      { serverId: alpha.id, serverName: "Alpha", serverType: "PLEX", mediaItemId: "a-1" },
      { serverId: beta.id, serverName: "Beta", serverType: "PLEX", mediaItemId: "b-1" },
    ]);
    expect(map.get("movie:7")?.map((s) => s.mediaItemId)).toEqual(["a-7", "b-old-1"]);
  });

  it("getServerPresenceByDedupKey leaves out servers it was not given", async () => {
    const { alpha } = await twoServerLibrary("MOVIE");
    const keys = Array.from({ length: PAST_THE_LIMIT }, (_, i) => `movie:${i + 1}`);

    const map = await getServerPresenceByDedupKey(keys, [alpha.id]);

    expect(map.get(`movie:${PAST_THE_LIMIT}`)).toEqual([
      { serverId: alpha.id, serverName: "Alpha", serverType: "PLEX", mediaItemId: `a-${PAST_THE_LIMIT}` },
    ]);
  });

  const routes: Array<[string, Kind, typeof moviesGet, string]> = [
    ["Movies", "MOVIE", moviesGet, "/api/media/movies"],
    ["Episodes", "SERIES", seriesGet, "/api/media/series"],
    ["Tracks", "MUSIC", musicGet, "/api/media/music"],
  ];

  for (const [name, kind, handler, path] of routes) {
    it(`the ${name} remainder request (limit=0&offset=100) lists every canonical row with both servers`, async () => {
      const { user, alpha, beta } = await twoServerLibrary(kind);
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(handler, { url: `${path}?limit=0&offset=100` });
      const body = await expectJson<ListBody>(response, 200);

      expect(body.items).toHaveLength(PAST_THE_LIMIT - 100);
      expect(body.pagination.hasMore).toBe(false);
      for (const item of [body.items[0], body.items[body.items.length - 1]]) {
        expect(item.servers.map((s) => s.serverId)).toEqual([alpha.id, beta.id]);
      }
    });
  }
});
