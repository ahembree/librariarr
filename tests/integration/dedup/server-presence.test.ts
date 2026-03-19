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
} from "@/lib/dedup/server-presence";

const testPrisma = getTestPrisma();

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

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("returns empty map for empty array", async () => {
    const result = await getServerPresenceByDedupKey([]);
    expect(result.size).toBe(0);
  });

  it("returns map with one entry for a single item with dedupKey", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Plex 1" });
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    await createItemWithDedupKey(lib.id, "movie:tmdb:123", {
      title: "The Matrix",
      type: "MOVIE",
    });

    const result = await getServerPresenceByDedupKey(["movie:tmdb:123"]);
    expect(result.size).toBe(1);
    expect(result.has("movie:tmdb:123")).toBe(true);

    const servers = result.get("movie:tmdb:123")!;
    expect(servers).toHaveLength(1);
    expect(servers[0].serverName).toBe("Plex 1");
    expect(servers[0].serverId).toBe(server.id);
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

    const result = await getServerPresenceByDedupKey(["movie:tmdb:456"]);
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

    const result = await getServerPresenceByDedupKey(["movie:tmdb:789"]);
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
    await createItemWithDedupKey(lib.id, "movie:tmdb:100", {
      title: "Keyed Movie",
      type: "MOVIE",
    });

    const result = await getServerPresenceByDedupKey(["movie:tmdb:100"]);
    expect(result.size).toBe(1);
    expect(result.has("movie:tmdb:100")).toBe(true);
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

    const result = await getServerPresenceByDedupKey(["movie:tmdb:200"]);
    const servers = result.get("movie:tmdb:200")!;
    expect(servers[0].serverName).toBe("Alpha Server");
    expect(servers[1].serverName).toBe("Zebra Server");
  });
});

describe("getServerPresenceByGroup", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("returns empty map for empty serverIds", async () => {
    const result = await getServerPresenceByGroup("SERIES", []);
    expect(result.size).toBe(0);
  });

  it("groups by normalized parentTitle", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Plex 1" });
    const lib = await createTestLibrary(server.id, { type: "SERIES" });

    await createTestMediaItem(lib.id, {
      title: "S01E01",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestMediaItem(lib.id, {
      title: "S01E02",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 2,
    });
    await createTestMediaItem(lib.id, {
      title: "S01E01",
      type: "SERIES",
      parentTitle: "The Wire",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    const result = await getServerPresenceByGroup("SERIES", [server.id]);
    expect(result.size).toBe(2);
    expect(result.has("breaking bad")).toBe(true);
    expect(result.has("the wire")).toBe(true);
  });

  it("shows multiple servers for same group", async () => {
    const user = await createTestUser();
    const server1 = await createTestServer(user.id, { name: "Alpha Server" });
    const server2 = await createTestServer(user.id, { name: "Beta Server" });
    const lib1 = await createTestLibrary(server1.id, { type: "SERIES" });
    const lib2 = await createTestLibrary(server2.id, { type: "SERIES" });

    await createTestMediaItem(lib1.id, {
      title: "S01E01",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestMediaItem(lib2.id, {
      title: "S01E01",
      type: "SERIES",
      parentTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    const result = await getServerPresenceByGroup("SERIES", [
      server1.id,
      server2.id,
    ]);
    const servers = result.get("breaking bad")!;
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
      title: "S01E01",
      type: "SERIES",
      parentTitle: "The Wire",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestMediaItem(lib2.id, {
      title: "S01E01",
      type: "SERIES",
      parentTitle: "The Wire",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    const result = await getServerPresenceByGroup("SERIES", [
      server1.id,
      server2.id,
    ]);
    const servers = result.get("the wire")!;
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
      title: "S01E01",
      type: "SERIES",
      parentTitle: "Show A",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestMediaItem(lib2.id, {
      title: "S01E01",
      type: "SERIES",
      parentTitle: "Show B",
      seasonNumber: 1,
      episodeNumber: 1,
    });

    // Only pass server1's id
    const result = await getServerPresenceByGroup("SERIES", [server1.id]);
    expect(result.size).toBe(1);
    expect(result.has("show a")).toBe(true);
    expect(result.has("show b")).toBe(false);
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
});
