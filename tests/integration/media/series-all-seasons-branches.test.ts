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

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/media/series/all-seasons/route";
import { appCache } from "@/lib/cache/memory-cache";

type Season = {
  parentTitle: string;
  seasonNumber: number;
  episodeCount: number;
  totalSize: string;
  summary: string | null;
  servers: { serverId: string; serverName: string }[];
};

describe("GET /api/media/series/all-seasons — sorts, date filters, multi-server", () => {
  let userId: string;
  let libraryId: string;

  async function seasons(searchParams: Record<string, string> = {}) {
    const body = await expectJson<{ seasons: Season[] }>(
      await callRoute(GET, { url: "/api/media/series/all-seasons", searchParams }),
    );
    return body.seasons;
  }
  const labels = async (sp: Record<string, string> = {}) =>
    (await seasons(sp)).map((s) => `${s.parentTitle} S${s.seasonNumber}`);

  beforeEach(async () => {
    appCache.clear();
    await cleanDatabase();
    clearMockSession();
    userId = (await createTestUser()).id;
    setMockSession({ userId, isLoggedIn: true });
    const server = await createTestServer(userId, { name: "Zulu" });
    libraryId = (await createTestLibrary(server.id, { type: "SERIES" })).id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function seed() {
    // Show A season 1: big, played long ago, added long ago
    await createTestMediaItem(libraryId, {
      type: "SERIES", title: "a1", parentTitle: "Show A", seasonNumber: 1, episodeNumber: 1,
      fileSize: BigInt(9_000), lastPlayedAt: new Date("2020-01-01T00:00:00Z"),
      addedAt: new Date("2019-01-01T00:00:00Z"),
    });
    // Show A season 2: small, never played, added recently
    await createTestMediaItem(libraryId, {
      type: "SERIES", title: "a2", parentTitle: "Show A", seasonNumber: 2, episodeNumber: 1,
      fileSize: BigInt(1_000), addedAt: new Date("2024-06-01T00:00:00Z"),
    });
    // Show B season 1: middle size, played recently, added mid
    await createTestMediaItem(libraryId, {
      type: "SERIES", title: "b1", parentTitle: "Show B", seasonNumber: 1, episodeNumber: 1,
      fileSize: BigInt(5_000), lastPlayedAt: new Date("2024-05-01T00:00:00Z"),
      addedAt: new Date("2022-01-01T00:00:00Z"),
    });
  }

  it("sorts by size, last played, added and season number", async () => {
    await seed();
    expect(await labels({ sortBy: "totalSize" })).toEqual(["Show A S2", "Show B S1", "Show A S1"]);
    expect(await labels({ sortBy: "totalSize", sortOrder: "desc" })).toEqual(["Show A S1", "Show B S1", "Show A S2"]);
    expect(await labels({ sortBy: "lastPlayed", sortOrder: "desc" })).toEqual(["Show B S1", "Show A S1", "Show A S2"]);
    expect(await labels({ sortBy: "addedAt", sortOrder: "desc" })).toEqual(["Show A S2", "Show B S1", "Show A S1"]);
    expect(await labels({ sortBy: "addedAt" })).toEqual(["Show A S1", "Show B S1", "Show A S2"]);
    // Season number first, ties broken by title.
    expect(await labels({ sortBy: "seasonNumber" })).toEqual(["Show A S1", "Show B S1", "Show A S2"]);
    expect(await labels({ sortOrder: "desc" })).toEqual(["Show B S1", "Show A S1", "Show A S2"]);
  });

  it("answers added-at filters on the season's newest addition", async () => {
    await seed();
    expect(await labels({ addedAtMin: "2023-01-01" })).toEqual(["Show A S2"]);
    expect(await labels({ addedAtMax: "2021-01-01" })).toEqual(["Show A S1"]);
    // A season never played is excluded by any last-played bound.
    expect(await labels({ lastPlayedAtMin: "2000-01-01" })).toEqual(["Show A S1", "Show B S1"]);
  });

  it("takes a season's summary from a sibling episode when the art row has none", async () => {
    const art = await createTestMediaItem(libraryId, {
      type: "SERIES", title: "e1", parentTitle: "Show C", seasonNumber: 1, episodeNumber: 1,
    });
    await getTestPrisma().mediaItem.update({ where: { id: art.id }, data: { seasonThumbUrl: "/s/1" } });
    await createTestMediaItem(libraryId, {
      type: "SERIES", title: "e2", parentTitle: "Show C", seasonNumber: 1, episodeNumber: 2,
      summary: "The second episode's blurb.",
    });
    const [season] = await seasons();
    expect(season.episodeCount).toBe(2);
    expect(season.summary).toBe("The second episode's blurb.");
  });

  it("lists only canonical copies across servers and the canonical copy's server", async () => {
    const other = await createTestServer(userId, { name: "Alpha" });
    const otherLib = await createTestLibrary(other.id, { type: "SERIES" });
    const prisma = getTestPrisma();
    const a = await createTestMediaItem(libraryId, {
      type: "SERIES", title: "p1", parentTitle: "Shared", seasonNumber: 1, episodeNumber: 1,
      seriesKey: "tvdb:1",
    });
    const b = await createTestMediaItem(otherLib.id, {
      type: "SERIES", title: "p1", parentTitle: "Shared", seasonNumber: 1, episodeNumber: 1,
      seriesKey: "tvdb:1",
    });
    await prisma.mediaItem.update({ where: { id: a.id }, data: { dedupKey: "k1", dedupCanonical: true } });
    await prisma.mediaItem.update({ where: { id: b.id }, data: { dedupKey: "k1", dedupCanonical: false } });

    const list = await seasons();
    expect(list).toHaveLength(1);
    expect(list[0].episodeCount).toBe(1);
    // The non-canonical copy is filtered out before aggregation.
    expect(list[0].servers.map((s) => s.serverName)).toEqual(["Zulu"]);
  });

  it("narrows with an episode filter on a multi-server install", async () => {
    const other = await createTestServer(userId, { name: "Alpha" });
    const otherLib = await createTestLibrary(other.id, { type: "SERIES" });
    await createTestMediaItem(libraryId, {
      type: "SERIES", title: "x", parentTitle: "UHD Show", seasonNumber: 1, episodeNumber: 1, resolution: "4k",
    });
    await createTestMediaItem(otherLib.id, {
      type: "SERIES", title: "y", parentTitle: "HD Show", seasonNumber: 1, episodeNumber: 1, resolution: "1080",
    });
    expect(await labels({ resolution: "4K" })).toEqual(["UHD Show S1"]);
  });
});
