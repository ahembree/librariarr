import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanDatabase,
  disconnectTestDb,
  getTestPrisma,
} from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import {
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

// Import AFTER mocks
import {
  getServerPresenceByDedupKey,
  getServerPresenceByGroup,
  getServerPresenceForGroup,
} from "@/lib/dedup/server-presence";

const testPrisma = getTestPrisma();

// One teardown for the whole file: disconnecting at the end of the first
// describe would leave the second running on a closed client.
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

/** Helper to create a media item and then set its dedupKey via direct update. */
async function createItemWithDedupKey(
  libraryId: string,
  dedupKey: string,
  overrides: Parameters<typeof createTestMediaItem>[1] = {},
) {
  const item = await createTestMediaItem(libraryId, overrides);
  await testPrisma.mediaItem.update({
    where: { id: item.id },
    data: { dedupKey },
  });
  return { ...item, dedupKey };
}

describe("getServerPresenceByDedupKey", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  it("returns empty map for empty array", async () => {
    const result = await getServerPresenceByDedupKey([], []);
    expect(result.size).toBe(0);
  });

  it("returns map with one entry for a single item with dedupKey", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Plex 1" });
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    const matrix = await createItemWithDedupKey(lib.id, "movie:tmdb:603", {
      title: "The Matrix",
      type: "MOVIE",
    });

    const result = await getServerPresenceByDedupKey(["movie:tmdb:603"], [server.id]);
    expect(result.size).toBe(1);
    expect(result.get("movie:tmdb:603")).toEqual([
      { serverId: server.id, serverName: "Plex 1", serverType: "PLEX", mediaItemId: matrix.id },
    ]);
  });

  it("shows all server presences for items with same dedupKey from different servers", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Alpha Server" });
    const server2 = await createTestServer(user.id, { name: "Beta Server" });
    const lib1 = await createTestLibrary(server1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(server2.id, { type: "MOVIE" });

    await createItemWithDedupKey(lib1.id, "movie:tmdb:456", {
      title: "Inception",
      type: "MOVIE",
    });
    await createItemWithDedupKey(lib2.id, "movie:tmdb:456", {
      title: "Inception",
      type: "MOVIE",
    });

    const result = await getServerPresenceByDedupKey(["movie:tmdb:456"], [server1.id, server2.id]);
    expect(result.size).toBe(1);
    const servers = result.get("movie:tmdb:456")!;
    expect(servers).toHaveLength(2);
    expect(servers.map((s) => s.serverName)).toContain("Alpha Server");
    expect(servers.map((s) => s.serverName)).toContain("Beta Server");
  });

  it("does not produce duplicate server entries per dedupKey", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Plex 1" });
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });

    // Two items on the same server with the same dedupKey
    await createItemWithDedupKey(lib.id, "movie:tmdb:789", {
      title: "Movie A",
      type: "MOVIE",
    });
    await createItemWithDedupKey(lib.id, "movie:tmdb:789", {
      title: "Movie A Duplicate",
      type: "MOVIE",
    });

    const result = await getServerPresenceByDedupKey(["movie:tmdb:789"], [server.id]);
    const servers = result.get("movie:tmdb:789")!;
    expect(servers).toHaveLength(1);
    expect(servers[0].serverId).toBe(server.id);
  });

  it("excludes items with null dedupKey (not in query keys)", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Plex 1" });
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });

    // Item without dedupKey (default null)
    await createTestMediaItem(lib.id, { title: "No Key Movie", type: "MOVIE" });
    const keyed = await createItemWithDedupKey(lib.id, "movie:tmdb:100", {
      title: "Keyed Movie",
      type: "MOVIE",
    });

    const result = await getServerPresenceByDedupKey(["movie:tmdb:100"], [server.id]);
    expect([...result.keys()]).toEqual(["movie:tmdb:100"]);
    expect(result.get("movie:tmdb:100")!.map((s) => s.mediaItemId)).toEqual([keyed.id]);
  });

  it("excludes servers not in the provided serverIds (filtered/disabled)", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Included Server" });
    const server2 = await createTestServer(user.id, { name: "Excluded Server" });
    const lib1 = await createTestLibrary(server1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(server2.id, { type: "MOVIE" });

    await createItemWithDedupKey(lib1.id, "movie:tmdb:300", { title: "Shared", type: "MOVIE" });
    await createItemWithDedupKey(lib2.id, "movie:tmdb:300", { title: "Shared", type: "MOVIE" });

    // Only server1 is in scope -- server2's presence must not leak into the badge.
    const result = await getServerPresenceByDedupKey(["movie:tmdb:300"], [server1.id]);
    const servers = result.get("movie:tmdb:300")!;
    expect(servers).toHaveLength(1);
    expect(servers[0].serverId).toBe(server1.id);
  });

  it("sorts servers alphabetically within each group", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Zebra Server" });
    const server2 = await createTestServer(user.id, { name: "Alpha Server" });
    const lib1 = await createTestLibrary(server1.id, { type: "MOVIE" });
    const lib2 = await createTestLibrary(server2.id, { type: "MOVIE" });

    await createItemWithDedupKey(lib1.id, "movie:tmdb:200", {
      title: "Test",
      type: "MOVIE",
    });
    await createItemWithDedupKey(lib2.id, "movie:tmdb:200", {
      title: "Test",
      type: "MOVIE",
    });

    const result = await getServerPresenceByDedupKey(["movie:tmdb:200"], [server1.id, server2.id]);
    const servers = result.get("movie:tmdb:200")!;
    expect(servers[0].serverName).toBe("Alpha Server");
    expect(servers[1].serverName).toBe("Zebra Server");
  });
});

describe("getServerPresenceByDedupKey copy choice", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  it("links the oldest copy when one server holds two, whatever order the rows are stored in", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Main" });
    const uhd = await createTestLibrary(server.id, { title: "Movies 4K" });
    const hd = await createTestLibrary(server.id, { title: "Movies" });
    // The newer copy is written first, so a read in storage order meets it
    // before the older one.
    const newer = await createItemWithDedupKey(uhd.id, "movie:tmdb:603");
    const older = await createItemWithDedupKey(hd.id, "movie:tmdb:603");
    await testPrisma.mediaItem.update({ where: { id: newer.id }, data: { createdAt: new Date("2025-01-01T00:00:00Z") } });
    await testPrisma.mediaItem.update({ where: { id: older.id }, data: { createdAt: new Date("2024-01-01T00:00:00Z") } });

    const result = await getServerPresenceByDedupKey(["movie:tmdb:603"], [server.id]);
    expect(result.get("movie:tmdb:603")).toEqual([
      { serverId: server.id, serverName: "Main", serverType: "PLEX", mediaItemId: older.id },
    ]);
  });

  it("orders two servers with the same name by id", async () => {
    const user = await createTestUser();
    // Ids chosen against insertion order: the server written first sorts last
    // by id, so a stable sort of the rows as read keeps them the wrong way round.
    const z = await testPrisma.mediaServer.create({
      data: { id: "srv-z", userId: user.id, type: "PLEX", name: "Plex", url: "http://10.0.0.2:32400", accessToken: "t" },
    });
    const a = await testPrisma.mediaServer.create({
      data: { id: "srv-a", userId: user.id, type: "PLEX", name: "Plex", url: "http://10.0.0.1:32400", accessToken: "t" },
    });
    await createItemWithDedupKey((await createTestLibrary(z.id)).id, "movie:tmdb:1");
    await createItemWithDedupKey((await createTestLibrary(a.id)).id, "movie:tmdb:1");

    const result = await getServerPresenceByDedupKey(["movie:tmdb:1"], [z.id, a.id]);
    expect(result.get("movie:tmdb:1")!.map((s) => s.serverId)).toEqual(["srv-a", "srv-z"]);
  });
});

describe("getServerPresenceByGroup", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  it("returns empty map for empty serverIds", async () => {
    const result = await getServerPresenceByGroup("SERIES", []);
    expect(result.size).toBe(0);
  });

  it("groups SERIES by seriesKey (title fallback), keyed by that key", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Plex 1" });
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    await createTestMediaItem(lib.id, {
      title: "Pilot",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestMediaItem(lib.id, {
      title: "Cat's in the Bag...",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 2,
    });
    await createTestMediaItem(lib.id, {
      title: "The Target",
      type: "SERIES",
      parentTitle: "The Wire",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    const result = await getServerPresenceByGroup("SERIES", [server.id]);
    expect(result.size).toBe(2);
    expect(result.has("title:breaking bad")).toBe(true);
    expect(result.has("title:the wire")).toBe(true);
  });

  it("shows multiple servers for same group", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Alpha Server" });
    const server2 = await createTestServer(user.id, { name: "Beta Server" });
    const lib1 = await createTestLibrary(server1.id, { type: "SERIES" });
    const lib2 = await createTestLibrary(server2.id, { type: "SERIES" });

    await createTestMediaItem(lib1.id, {
      title: "Pilot",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestMediaItem(lib2.id, {
      title: "Pilot",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    const result = await getServerPresenceByGroup("SERIES", [
      server1.id,
      server2.id,
    ]);
    const servers = result.get("title:breaking bad")!;
    expect(servers).toHaveLength(2);
    expect(servers.map((s) => s.serverName)).toContain("Alpha Server");
    expect(servers.map((s) => s.serverName)).toContain("Beta Server");
  });

  it("sorts servers alphabetically within each group", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Zulu Server" });
    const server2 = await createTestServer(user.id, { name: "Alpha Server" });
    const lib1 = await createTestLibrary(server1.id, { type: "SERIES" });
    const lib2 = await createTestLibrary(server2.id, { type: "SERIES" });

    await createTestMediaItem(lib1.id, {
      title: "The Target",
      type: "SERIES",
      parentTitle: "The Wire",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestMediaItem(lib2.id, {
      title: "The Target",
      type: "SERIES",
      parentTitle: "The Wire",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    const result = await getServerPresenceByGroup("SERIES", [
      server1.id,
      server2.id,
    ]);
    const servers = result.get("title:the wire")!;
    expect(servers[0].serverName).toBe("Alpha Server");
    expect(servers[1].serverName).toBe("Zulu Server");
  });

  it("only includes items matching the given serverIds", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Included" });
    const server2 = await createTestServer(user.id, { name: "Excluded" });
    const lib1 = await createTestLibrary(server1.id, { type: "SERIES" });
    const lib2 = await createTestLibrary(server2.id, { type: "SERIES" });

    await createTestMediaItem(lib1.id, {
      title: "Pilot",
      type: "SERIES",
      parentTitle: "Show A",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestMediaItem(lib2.id, {
      title: "Pilot",
      type: "SERIES",
      parentTitle: "Show B",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    // Only pass server1's id
    const result = await getServerPresenceByGroup("SERIES", [server1.id]);
    expect(result.size).toBe(1);
    expect(result.has("title:show a")).toBe(true);
    expect(result.has("title:show b")).toBe(false);
  });

  it("works with MUSIC type grouping by artist", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Music Server" });
    const lib = await createTestLibrary(server.id, { type: "MUSIC" });

    await createTestMediaItem(lib.id, {
      title: "Song 1",
      type: "MUSIC",
      parentTitle: "The Beatles",
    });
    await createTestMediaItem(lib.id, {
      title: "Song 2",
      type: "MUSIC",
      parentTitle: "The Beatles",
    });

    const result = await getServerPresenceByGroup("MUSIC", [server.id]);
    expect(result.has("the beatles")).toBe(true);
    const servers = result.get("the beatles")!;
    expect(servers).toHaveLength(1);
    expect(servers[0].serverName).toBe("Music Server");
  });

  it("separates two same-titled shows with different seriesKeys", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Plex" });
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    // Two genuinely different shows that share a title, keyed by distinct TVDB ids.
    await createTestMediaItem(lib.id, {
      title: "Downsize", type: "SERIES", parentTitle: "The Office",
      seriesKey: "tvdb:78107", seasonNumber: 1, episodeNumber: 1,
    });
    await createTestMediaItem(lib.id, {
      title: "Pilot", type: "SERIES", parentTitle: "The Office",
      seriesKey: "tvdb:73244", seasonNumber: 1, episodeNumber: 1,
    });

    const result = await getServerPresenceByGroup("SERIES", [server.id]);
    // Two distinct groups even though the title is identical.
    expect(result.size).toBe(2);
    expect(result.has("tvdb:78107")).toBe(true);
    expect(result.has("tvdb:73244")).toBe(true);
    expect(result.has("title:the office")).toBe(false);
  });

  it("links each server's oldest copy of the group, ties by id", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Plex" });
    const lib = await createTestLibrary(server.id, { type: "SERIES" });
    const ep = (title: string) =>
      createTestMediaItem(lib.id, { title, type: "SERIES", parentTitle: "Show", seriesKey: "tvdb:1" });
    const newer = await ep("Newer");
    const older = await ep("Older");
    const tieA = await ep("Tie A");
    const tieB = await ep("Tie B");
    const at = (iso: string) => new Date(iso);
    await testPrisma.mediaItem.update({ where: { id: newer.id }, data: { createdAt: at("2024-05-01T00:00:00.000Z") } });
    await testPrisma.mediaItem.update({ where: { id: older.id }, data: { createdAt: at("2024-01-01T00:00:00.123Z") } });
    // Two copies a millisecond older still: the lower id wins the tie.
    await testPrisma.mediaItem.update({ where: { id: tieA.id }, data: { createdAt: at("2024-01-01T00:00:00.122Z") } });
    await testPrisma.mediaItem.update({ where: { id: tieB.id }, data: { createdAt: at("2024-01-01T00:00:00.122Z") } });

    const result = await getServerPresenceByGroup("SERIES", [server.id]);
    expect(result.get("tvdb:1")!.map((s) => s.mediaItemId)).toEqual([[tieA.id, tieB.id].sort()[0]]);
  });

  it("answers for only the groups it is given", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Alpha" });
    const server2 = await createTestServer(user.id, { name: "Beta" });
    const lib1 = await createTestLibrary(server1.id, { type: "SERIES" });
    const lib2 = await createTestLibrary(server2.id, { type: "SERIES" });
    for (const lib of [lib1, lib2]) {
      for (const key of ["tvdb:1", "tvdb:2", "tvdb:3"]) {
        await createTestMediaItem(lib.id, { type: "SERIES", parentTitle: key, seriesKey: key });
      }
    }

    const whole = await getServerPresenceByGroup("SERIES", [server1.id, server2.id]);
    const scoped = await getServerPresenceByGroup("SERIES", [server1.id, server2.id], { groupKeys: ["tvdb:1", "tvdb:3"] });
    expect([...scoped.keys()].sort()).toEqual(["tvdb:1", "tvdb:3"]);
    expect(scoped.get("tvdb:1")).toEqual(whole.get("tvdb:1"));
    expect(scoped.get("tvdb:3")).toEqual(whole.get("tvdb:3"));
    expect((await getServerPresenceByGroup("SERIES", [server1.id], { groupKeys: [] })).size).toBe(0);
  });

  it("reads one artist's presence by any spelling of its name", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Alpha" });
    const server2 = await createTestServer(user.id, { name: "Beta" });
    const lib1 = await createTestLibrary(server1.id, { type: "MUSIC" });
    const lib2 = await createTestLibrary(server2.id, { type: "MUSIC" });
    await createTestMediaItem(lib1.id, { type: "MUSIC", parentTitle: "Air" });
    await createTestMediaItem(lib2.id, { type: "MUSIC", parentTitle: " air " });
    await createTestMediaItem(lib2.id, { type: "MUSIC", parentTitle: "Other" });

    const presence = await getServerPresenceForGroup("MUSIC", [server1.id, server2.id], { parentTitle: "AIR" });
    expect(presence.map((s) => s.serverName)).toEqual(["Alpha", "Beta"]);
    expect(await getServerPresenceForGroup("MUSIC", [server1.id, server2.id], { parentTitle: "Nobody" })).toEqual([]);
    expect(
      (await getServerPresenceForGroup("SERIES", [server1.id], { seriesKey: "tvdb:none" })),
    ).toEqual([]);
  });

  it("merges the same show across servers via a shared seriesKey", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Alpha" });
    const server2 = await createTestServer(user.id, { name: "Beta" });
    const lib1 = await createTestLibrary(server1.id, { type: "SERIES" });
    const lib2 = await createTestLibrary(server2.id, { type: "SERIES" });

    // Same show, different title spelling on each server, but a shared TVDB id.
    await createTestMediaItem(lib1.id, {
      title: "33", type: "SERIES", parentTitle: "Battlestar Galactica",
      seriesKey: "tvdb:73545", seasonNumber: 1, episodeNumber: 1,
    });
    await createTestMediaItem(lib2.id, {
      title: "33", type: "SERIES", parentTitle: "battlestar galactica ",
      seriesKey: "tvdb:73545", seasonNumber: 1, episodeNumber: 1,
    });

    const result = await getServerPresenceByGroup("SERIES", [server1.id, server2.id]);
    expect(result.size).toBe(1);
    const servers = result.get("tvdb:73545")!;
    expect(servers.map((s) => s.serverName).sort()).toEqual(["Alpha", "Beta"]);
  });
});
