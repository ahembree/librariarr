import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  cleanDatabase,
  disconnectTestDb,
  getTestPrisma,
} from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import route handler AFTER mocks
import { GET } from "@/app/api/media/series/watch-history/route";

interface HistoryRow {
  id: string;
  serverUsername: string;
  watchedAt: string | null;
  deviceName: string | null;
  platform: string | null;
  mediaItem: {
    id: string;
    title: string;
    parentTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
  };
  server: { id: string; name: string; type: string };
}

interface HistoryResponse {
  items: HistoryRow[];
  pagination: { page: number; limit: number; hasMore: boolean; totalCount: number };
}

describe("GET /api/media/series/watch-history", () => {
  let userId: string;
  let serverId: string;
  let libraryId: string;

  async function addWatch(
    mediaItemId: string,
    overrides?: Partial<{
      serverUsername: string;
      watchedAt: Date | null;
      deviceName: string;
      platform: string;
      mediaServerId: string;
    }>,
  ) {
    return getTestPrisma().watchHistory.create({
      data: {
        mediaItemId,
        mediaServerId: overrides?.mediaServerId ?? serverId,
        serverUsername: overrides?.serverUsername ?? "alice",
        watchedAt:
          overrides?.watchedAt === undefined
            ? new Date("2024-06-01T20:00:00Z")
            : overrides.watchedAt,
        deviceName: overrides?.deviceName,
        platform: overrides?.platform,
      },
    });
  }

  /** Creates an episode row and returns its id. */
  async function makeEpisode(
    seasonNumber: number,
    episodeNumber: number,
    title: string,
    parentTitle = "Adventure Time",
    libId = libraryId,
  ): Promise<string> {
    const item = await createTestMediaItem(libId, {
      type: "SERIES",
      title,
      parentTitle,
      seasonNumber,
      episodeNumber,
    });
    return item.id;
  }

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true, plexToken: "token" });
    const server = await createTestServer(userId);
    serverId = server.id;
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    libraryId = library.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    clearMockSession();
    const response = await callRoute(GET, {
      url: "/api/media/series/watch-history",
      searchParams: { parentTitle: "Adventure Time" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 without parentTitle", async () => {
    const body = await expectJson<{ error: string }>(
      await callRoute(GET, { url: "/api/media/series/watch-history" }),
      400,
    );
    expect(body.error).toBe("seriesKey or parentTitle is required");
  });

  it("returns 400 for a non-numeric seasonNumber", async () => {
    const body = await expectJson<{ error: string }>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time", seasonNumber: "abc" },
      }),
      400,
    );
    expect(body.error).toBe("seasonNumber must be a number");
  });

  it("returns 400 for a non-numeric episodeNumber", async () => {
    const body = await expectJson<{ error: string }>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time", episodeNumber: "abc" },
      }),
      400,
    );
    expect(body.error).toBe("episodeNumber must be a number");
  });

  it("returns every play across all seasons of the series, with user/time/episode", async () => {
    const s1e1 = await makeEpisode(1, 1, "Slumber Party Panic");
    const s2e3 = await makeEpisode(2, 3, "Loyal to the King");
    await addWatch(s1e1);
    await addWatch(s2e3, {
      serverUsername: "bob",
      watchedAt: new Date("2024-07-04T18:30:00Z"),
      deviceName: "Living Room TV",
      platform: "Roku",
    });

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time" },
      }),
    );

    expect(data.pagination.totalCount).toBe(2);
    expect(data.items).toHaveLength(2);
    // Newest play first
    expect(data.items[0].serverUsername).toBe("bob");
    expect(data.items[0].watchedAt).toBe("2024-07-04T18:30:00.000Z");
    expect(data.items[0].deviceName).toBe("Living Room TV");
    expect(data.items[0].platform).toBe("Roku");
    expect(data.items[0].mediaItem).toMatchObject({
      title: "Loyal to the King",
      seasonNumber: 2,
      episodeNumber: 3,
      parentTitle: "Adventure Time",
    });
    expect(data.items[1].serverUsername).toBe("alice");
    expect(data.items[1].mediaItem.title).toBe("Slumber Party Panic");
  });

  it("scopes to a single season when seasonNumber is given", async () => {
    const s1e1 = await makeEpisode(1, 1, "Slumber Party Panic");
    const s2e3 = await makeEpisode(2, 3, "Loyal to the King");
    await addWatch(s1e1);
    await addWatch(s2e3);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time", seasonNumber: "2" },
      }),
    );

    expect(data.pagination.totalCount).toBe(1);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].mediaItem.seasonNumber).toBe(2);
    expect(data.items[0].mediaItem.title).toBe("Loyal to the King");
  });

  it("treats season 0 (Specials) as a real season, not 'all seasons'", async () => {
    const special = await makeEpisode(0, 1, "Christmas Special");
    const s1e1 = await makeEpisode(1, 1, "Slumber Party Panic");
    await addWatch(special);
    await addWatch(s1e1);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time", seasonNumber: "0" },
      }),
    );

    expect(data.pagination.totalCount).toBe(1);
    expect(data.items[0].mediaItem.title).toBe("Christmas Special");
  });

  it("scopes to a single episode when episodeNumber is given", async () => {
    const s1e1 = await makeEpisode(1, 1, "Slumber Party Panic");
    const s1e2 = await makeEpisode(1, 2, "Trouble in Lumpy Space");
    await addWatch(s1e1);
    await addWatch(s1e2);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: {
          parentTitle: "Adventure Time",
          seasonNumber: "1",
          episodeNumber: "2",
        },
      }),
    );

    expect(data.pagination.totalCount).toBe(1);
    expect(data.items[0].mediaItem.title).toBe("Trouble in Lumpy Space");
  });

  it("excludes other series", async () => {
    const own = await makeEpisode(1, 1, "Slumber Party Panic");
    const other = await makeEpisode(1, 1, "Pilot", "Regular Show");
    await addWatch(own);
    await addWatch(other);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time" },
      }),
    );

    expect(data.pagination.totalCount).toBe(1);
    expect(data.items[0].mediaItem.parentTitle).toBe("Adventure Time");
  });

  it("excludes history recorded on another user's server", async () => {
    const otherUser = await createTestUser({ username: "other" });
    const otherServer = await createTestServer(otherUser.id, { name: "Other" });
    const otherLibrary = await createTestLibrary(otherServer.id, { type: "SERIES" });
    const foreign = await makeEpisode(1, 1, "Slumber Party Panic", "Adventure Time", otherLibrary.id);
    await addWatch(foreign, { mediaServerId: otherServer.id, serverUsername: "mallory" });

    const mine = await makeEpisode(1, 2, "Trouble in Lumpy Space");
    await addWatch(mine);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time" },
      }),
    );

    expect(data.pagination.totalCount).toBe(1);
    expect(data.items[0].serverUsername).toBe("alice");
  });

  it("keeps plays from every server, including non-canonical copies", async () => {
    // A play is a real event on whichever copy was played — dedup filtering
    // would silently drop the plays that happened on the non-canonical server.
    const server2 = await createTestServer(userId, { name: "Second" });
    const library2 = await createTestLibrary(server2.id, { type: "SERIES" });
    const canonical = await makeEpisode(1, 1, "Slumber Party Panic");
    const copy = await makeEpisode(1, 1, "Slumber Party Panic", "Adventure Time", library2.id);
    await getTestPrisma().mediaItem.update({
      where: { id: canonical },
      data: { dedupKey: "shared-key", dedupCanonical: true },
    });
    await getTestPrisma().mediaItem.update({
      where: { id: copy },
      data: { dedupKey: "shared-key", dedupCanonical: false },
    });
    await addWatch(canonical);
    await addWatch(copy, { mediaServerId: server2.id, serverUsername: "bob" });

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time" },
      }),
    );

    expect(data.pagination.totalCount).toBe(2);
    expect(data.items.map((i) => i.server.name).sort()).toEqual(["Second", "Test Server"]);
  });

  it("includes every server user's plays, not just the connected account's", async () => {
    // WatchHistory is populated from the server-WIDE, per-user
    // getDetailedWatchHistory(), and nothing here filters on serverUsername —
    // session.userId is the Librariarr admin who owns the server record, not a
    // media-server account. A household member's plays must show up.
    const episode = await makeEpisode(1, 1, "Slumber Party Panic");
    for (const who of ["alice", "bob", "carol", "dave"]) {
      await addWatch(episode, { serverUsername: who });
    }

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time" },
      }),
    );

    expect(data.pagination.totalCount).toBe(4);
    expect([...new Set(data.items.map((i) => i.serverUsername))].sort()).toEqual([
      "alice",
      "bob",
      "carol",
      "dave",
    ]);
  });

  it("matches the series the way the library groups it — case- and whitespace-insensitively", async () => {
    // /api/media/series/grouped keys shows on LOWER(TRIM(parentTitle)), so two
    // servers spelling a show differently are ONE show in the UI. Matching
    // parentTitle exactly looked right on one server and silently dropped the
    // other server's plays — exactly the cross-server plays this route keeps by
    // not applying dedup.
    const server2 = await createTestServer(userId, { name: "Second" });
    const library2 = await createTestLibrary(server2.id, { type: "SERIES" });
    const plexCopy = await makeEpisode(1, 1, "Slumber Party Panic", "Adventure Time");
    const jellyfinCopy = await makeEpisode(1, 1, "Slumber Party Panic", "adventure time ", library2.id);
    await addWatch(plexCopy, { serverUsername: "alice" });
    await addWatch(jellyfinCopy, { mediaServerId: server2.id, serverUsername: "dave" });

    for (const spelling of ["Adventure Time", "adventure time ", "ADVENTURE TIME"]) {
      const data = await expectJson<HistoryResponse>(
        await callRoute(GET, {
          url: "/api/media/series/watch-history",
          searchParams: { parentTitle: spelling },
        }),
      );
      expect(data.pagination.totalCount).toBe(2);
      expect(data.items.map((i) => i.serverUsername).sort()).toEqual(["alice", "dave"]);
    }
  });

  it("does not treat a wildcard character in the title as a pattern", async () => {
    // Case-insensitive matching via ILIKE would make "100% Wolf" match every
    // show starting with "100"; the normalized equality comparison must not.
    const wolf = await makeEpisode(1, 1, "Pilot", "100% Wolf");
    const decoy = await makeEpisode(1, 1, "Pilot", "100 Foot Wave");
    await addWatch(wolf, { serverUsername: "alice" });
    await addWatch(decoy, { serverUsername: "bob" });

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "100% Wolf" },
      }),
    );

    expect(data.pagination.totalCount).toBe(1);
    expect(data.items[0].serverUsername).toBe("alice");
  });

  it("filters to one server when serverId is given", async () => {
    const server2 = await createTestServer(userId, { name: "Second" });
    const library2 = await createTestLibrary(server2.id, { type: "SERIES" });
    const own = await makeEpisode(1, 1, "Slumber Party Panic");
    const copy = await makeEpisode(1, 1, "Slumber Party Panic", "Adventure Time", library2.id);
    await addWatch(own);
    await addWatch(copy, { mediaServerId: server2.id, serverUsername: "bob" });

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time", serverId: server2.id },
      }),
    );

    expect(data.pagination.totalCount).toBe(1);
    expect(data.items[0].server.id).toBe(server2.id);
  });

  it("paginates without duplicating or dropping rows when timestamps tie", async () => {
    const episode = await makeEpisode(1, 1, "Slumber Party Panic");
    const tie = new Date("2024-06-01T20:00:00Z");
    for (let i = 0; i < 5; i++) {
      await addWatch(episode, { serverUsername: `user${i}`, watchedAt: tie });
    }

    const page1 = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time", limit: "2", page: "1" },
      }),
    );
    const page2 = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time", limit: "2", page: "2" },
      }),
    );
    const page3 = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time", limit: "2", page: "3" },
      }),
    );

    expect(page1.pagination.totalCount).toBe(5);
    expect(page1.pagination.hasMore).toBe(true);
    expect(page2.pagination.hasMore).toBe(true);
    expect(page3.pagination.hasMore).toBe(false);
    const ids = [...page1.items, ...page2.items, ...page3.items].map((i) => i.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it("sorts rows with no timestamp last rather than first", async () => {
    const episode = await makeEpisode(1, 1, "Slumber Party Panic");
    await addWatch(episode, { serverUsername: "no-date", watchedAt: null });
    await addWatch(episode, { serverUsername: "dated" });

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time" },
      }),
    );

    expect(data.items.map((i) => i.serverUsername)).toEqual(["dated", "no-date"]);
  });

  it("clamps a zero/negative limit instead of returning nothing", async () => {
    const episode = await makeEpisode(1, 1, "Slumber Party Panic");
    await addWatch(episode);

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time", limit: "0" },
      }),
    );

    expect(data.pagination.limit).toBe(1);
    expect(data.items).toHaveLength(1);
  });

  it("returns an empty list for a series with no plays", async () => {
    await makeEpisode(1, 1, "Slumber Party Panic");

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { parentTitle: "Adventure Time" },
      }),
    );

    expect(data.items).toEqual([]);
    expect(data.pagination.totalCount).toBe(0);
    expect(data.pagination.hasMore).toBe(false);
  });

  it("scopes by seriesKey so two same-titled shows keep separate history", async () => {
    // Two "The Office" shows with different TVDB-derived seriesKeys.
    const uk = await createTestMediaItem(libraryId, {
      type: "SERIES", title: "Downsize", parentTitle: "The Office",
      seriesKey: "tvdb:78107", seasonNumber: 1, episodeNumber: 1,
    });
    const us = await createTestMediaItem(libraryId, {
      type: "SERIES", title: "Pilot", parentTitle: "The Office",
      seriesKey: "tvdb:73244", seasonNumber: 1, episodeNumber: 1,
    });
    await addWatch(uk.id, { serverUsername: "brit" });
    await addWatch(us.id, { serverUsername: "yank" });

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { seriesKey: "tvdb:73244" },
      }),
    );
    // Only the US show's play — the identically-titled UK show is not blended in.
    expect(data.pagination.totalCount).toBe(1);
    expect(data.items[0].serverUsername).toBe("yank");
  });

  it("merges the same show across servers by seriesKey (keeps cross-server plays)", async () => {
    const server2 = await createTestServer(userId, { name: "Second" });
    const library2 = await createTestLibrary(server2.id, { type: "SERIES" });
    // Same show, different spelling per server, shared TVDB-derived seriesKey.
    const plexCopy = await createTestMediaItem(libraryId, {
      type: "SERIES", title: "33", parentTitle: "Battlestar Galactica",
      seriesKey: "tvdb:73545", seasonNumber: 1, episodeNumber: 1,
    });
    const jellyfinCopy = await createTestMediaItem(library2.id, {
      type: "SERIES", title: "33", parentTitle: "battlestar galactica ",
      seriesKey: "tvdb:73545", seasonNumber: 1, episodeNumber: 1,
    });
    await addWatch(plexCopy.id, { serverUsername: "alice" });
    await addWatch(jellyfinCopy.id, { mediaServerId: server2.id, serverUsername: "dave" });

    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/series/watch-history",
        searchParams: { seriesKey: "tvdb:73545" },
      }),
    );
    // Both servers' plays are returned (dedup is deliberately not applied).
    expect(data.pagination.totalCount).toBe(2);
    expect(data.items.map((i) => i.serverUsername).sort()).toEqual(["alice", "dave"]);
  });
});
