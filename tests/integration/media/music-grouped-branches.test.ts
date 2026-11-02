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

import { GET } from "@/app/api/media/music/grouped/route";
import { appCache } from "@/lib/cache/memory-cache";

type Artist = { parentTitle: string; trackCount: number; albumCount: number; summary: string | null };

describe("GET /api/media/music/grouped — sorts and offset", () => {
  let libraryId: string;

  async function names(searchParams: Record<string, string> = {}) {
    const body = await expectJson<{ artists: Artist[]; pagination: { hasMore: boolean } }>(
      await callRoute(GET, { url: "/api/media/music/grouped", searchParams }),
    );
    return body.artists.map((a) => a.parentTitle);
  }

  beforeEach(async () => {
    appCache.clear();
    await cleanDatabase();
    clearMockSession();
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    libraryId = (await createTestLibrary(server.id, { type: "MUSIC" })).id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function track(artist: string, album: string, n: number, extra: Parameters<typeof createTestMediaItem>[1] = {}) {
    return createTestMediaItem(libraryId, {
      type: "MUSIC", title: `${artist} ${album} ${n}`, parentTitle: artist, albumTitle: album,
      episodeNumber: n, ...extra,
    });
  }

  async function seed() {
    // Abba: 3 tracks across 2 albums, small, played long ago, added long ago
    await track("Abba", "Gold", 1, { fileSize: BigInt(100), lastPlayedAt: new Date("2020-01-01"), addedAt: new Date("2019-01-01") });
    await track("Abba", "Gold", 2, { fileSize: BigInt(100), addedAt: new Date("2019-01-01") });
    await track("Abba", "Arrival", 1, { fileSize: BigInt(100), addedAt: new Date("2019-01-01") });
    // Muse: 1 track, huge, played recently, added recently
    await track("Muse", "Drones", 1, { fileSize: BigInt(9_000), lastPlayedAt: new Date("2024-01-01"), addedAt: new Date("2024-01-01") });
    // Zappa: 2 tracks, 1 album, middling, never played
    await track("Zappa", "Hot Rats", 1, { fileSize: BigInt(500), addedAt: new Date("2021-01-01") });
    await track("Zappa", "Hot Rats", 2, { fileSize: BigInt(500), addedAt: new Date("2021-01-01") });
  }

  it("sorts by every column it offers", async () => {
    await seed();
    expect(await names({ sortBy: "trackCount", sortOrder: "desc" })).toEqual(["Abba", "Zappa", "Muse"]);
    expect(await names({ sortBy: "albumCount", sortOrder: "desc" })).toEqual(["Abba", "Muse", "Zappa"]);
    expect(await names({ sortBy: "totalSize" })).toEqual(["Abba", "Zappa", "Muse"]);
    expect(await names({ sortBy: "lastPlayed", sortOrder: "desc" })).toEqual(["Muse", "Abba", "Zappa"]);
    expect(await names({ sortBy: "addedAt" })).toEqual(["Abba", "Zappa", "Muse"]);
    expect(await names({ sortOrder: "desc" })).toEqual(["Zappa", "Muse", "Abba"]);
  });

  it("returns everything after an offset with limit=0", async () => {
    await seed();
    const body = await expectJson<{ artists: Artist[]; pagination: { hasMore: boolean } }>(
      await callRoute(GET, { url: "/api/media/music/grouped", searchParams: { limit: "0", offset: "2" } }),
    );
    expect(body.artists.map((a) => a.parentTitle)).toEqual(["Zappa"]);
    expect(body.pagination.hasMore).toBe(false);
  });

  it("returns an empty list when the user has no servers", async () => {
    await getTestPrisma().mediaServer.deleteMany();
    expect(await names()).toEqual([]);
  });

  it("narrows by a starting letter alone", async () => {
    await seed();
    expect(await names({ startsWith: "M" })).toEqual(["Muse"]);
  });

  it("takes an artist's summary from another track when the art track has none", async () => {
    const art = await track("Bjork", "Post", 1, { thumbUrl: "/art/1" });
    await track("Bjork", "Post", 2, { summary: "Icelandic." });
    const body = await expectJson<{ artists: (Artist & { mediaItemId: string; thumbUrl: string | null })[] }>(
      await callRoute(GET, { url: "/api/media/music/grouped" }),
    );
    expect(body.artists).toHaveLength(1);
    // The art track is the one linked; the blurb comes from track 2.
    expect(body.artists[0].mediaItemId).toBe(art.id);
    expect(body.artists[0].thumbUrl).toBe("/art/1");
    expect(body.artists[0].summary).toBe("Icelandic.");
  });
});
