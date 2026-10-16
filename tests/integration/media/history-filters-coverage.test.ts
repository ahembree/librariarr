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

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/media/history/route";
import { appCache } from "@/lib/cache/memory-cache";

type HistoryItem = {
  id: string;
  serverUsername: string;
  watchedAt: string | null;
  deviceName: string | null;
  platform: string | null;
  mediaItem: {
    id: string;
    title: string;
    fileSize: string | null;
    lastPlayedAt: string | null;
    addedAt: string | null;
    genres: string[] | null;
    resolution: string | null;
  };
  server: { id: string; name: string; type: string };
};
type HistoryResponse = {
  items: HistoryItem[];
  pagination: { page: number; limit: number; hasMore: boolean; totalCount: number };
  usernames: string[];
  deviceNames: string[];
  platforms: string[];
};

async function get(searchParams: Record<string, string> = {}) {
  return expectJson<HistoryResponse>(
    await callRoute(GET, { url: "/api/media/history", searchParams }),
  );
}

function titles(body: HistoryResponse) {
  return body.items.map((i) => i.mediaItem.title).sort();
}

describe("GET /api/media/history — filter and sort branches", () => {
  let userId: string;
  let serverA: string;
  let serverB: string;
  let movieLib: string;

  async function play(
    mediaItemId: string,
    data: Partial<{
      serverUsername: string;
      deviceName: string | null;
      platform: string | null;
      watchedAt: Date | null;
      mediaServerId: string;
    }> = {},
  ) {
    return getTestPrisma().watchHistory.create({
      data: {
        mediaItemId,
        mediaServerId: data.mediaServerId ?? serverA,
        serverUsername: data.serverUsername ?? "alice",
        deviceName: data.deviceName === undefined ? "TV" : data.deviceName,
        platform: data.platform === undefined ? "Roku" : data.platform,
        watchedAt:
          data.watchedAt === undefined ? new Date("2024-06-01T00:00:00Z") : data.watchedAt,
      },
    });
  }

  beforeEach(async () => {
    appCache.clear();
    await cleanDatabase();
    clearMockSession();
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true });
    serverA = (await createTestServer(userId, { name: "Alpha" })).id;
    serverB = (await createTestServer(userId, { name: "Beta" })).id;
    movieLib = (await createTestLibrary(serverA, { type: "MOVIE" })).id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("filters by one and by several usernames, devices and platforms", async () => {
    const a = await createTestMediaItem(movieLib, { title: "A" });
    const b = await createTestMediaItem(movieLib, { title: "B" });
    const c = await createTestMediaItem(movieLib, { title: "C" });
    await play(a.id, { serverUsername: "alice", deviceName: "TV", platform: "Roku" });
    await play(b.id, { serverUsername: "bob", deviceName: "Phone", platform: "iOS" });
    await play(c.id, { serverUsername: "carol", deviceName: "Laptop", platform: "Web" });

    expect(titles(await get({ username: "bob" }))).toEqual(["B"]);
    expect(titles(await get({ username: "alice|carol" }))).toEqual(["A", "C"]);
    // A pipe-only value filters on nothing.
    expect(titles(await get({ username: "|" }))).toEqual(["A", "B", "C"]);

    expect(titles(await get({ deviceName: "Phone" }))).toEqual(["B"]);
    expect(titles(await get({ deviceName: "Phone|Laptop" }))).toEqual(["B", "C"]);
    expect(titles(await get({ deviceName: "|" }))).toHaveLength(3);

    expect(titles(await get({ platform: "Web" }))).toEqual(["C"]);
    expect(titles(await get({ platform: "Roku|iOS" }))).toEqual(["A", "B"]);
    expect(titles(await get({ platform: "|" }))).toHaveLength(3);
  });

  it("returns the sorted distinct filter values, skipping null devices and platforms", async () => {
    const a = await createTestMediaItem(movieLib, { title: "A" });
    await play(a.id, { serverUsername: "zed", deviceName: null, platform: null });
    await play(a.id, { serverUsername: "amy", deviceName: "TV", platform: "Roku" });
    await play(a.id, { serverUsername: "amy", deviceName: "Box", platform: "Android" });

    const body = await get();
    expect(body.usernames).toEqual(["amy", "zed"]);
    expect(body.deviceNames).toEqual(["Box", "TV"]);
    expect(body.platforms).toEqual(["Android", "Roku"]);
  });

  it("filters by server", async () => {
    const libB = (await createTestLibrary(serverB, { type: "MOVIE" })).id;
    const a = await createTestMediaItem(movieLib, { title: "On A" });
    const b = await createTestMediaItem(libB, { title: "On B" });
    await play(a.id);
    await play(b.id, { mediaServerId: serverB });

    const body = await get({ serverId: serverB });
    expect(titles(body)).toEqual(["On B"]);
    expect(body.items[0].server).toEqual({ id: serverB, name: "Beta", type: "PLEX" });
    expect(body.pagination.totalCount).toBe(1);
  });

  it("filters by resolution label (expanded) and by a raw value", async () => {
    const uhd = await createTestMediaItem(movieLib, { title: "UHD", resolution: "2160" });
    const hd = await createTestMediaItem(movieLib, { title: "HD", resolution: "1080p" });
    const odd = await createTestMediaItem(movieLib, { title: "Odd", resolution: "576" });
    await play(uhd.id);
    await play(hd.id);
    await play(odd.id);

    expect(titles(await get({ resolution: "4K" }))).toEqual(["UHD"]);
    expect(titles(await get({ resolution: "4K|1080P" }))).toEqual(["HD", "UHD"]);
    // An unknown label falls through as the literal value, case-insensitively.
    expect(titles(await get({ resolution: "576" }))).toEqual(["Odd"]);
    expect(titles(await get({ resolution: "|" }))).toHaveLength(3);
  });

  it("filters by dynamic range, video codec and audio codec (single and multi)", async () => {
    const a = await createTestMediaItem(movieLib, {
      title: "A", dynamicRange: "HDR10", videoCodec: "hevc", audioCodec: "truehd",
    });
    const b = await createTestMediaItem(movieLib, {
      title: "B", dynamicRange: "Dolby Vision", videoCodec: "av1", audioCodec: "eac3",
    });
    const c = await createTestMediaItem(movieLib, {
      title: "C", dynamicRange: "SDR", videoCodec: "h264", audioCodec: "aac",
    });
    for (const i of [a, b, c]) await play(i.id);

    expect(titles(await get({ dynamicRange: "HDR10" }))).toEqual(["A"]);
    expect(titles(await get({ dynamicRange: "HDR10|Dolby Vision" }))).toEqual(["A", "B"]);
    expect(titles(await get({ dynamicRange: "|" }))).toHaveLength(3);
    expect(titles(await get({ videoCodec: "av1" }))).toEqual(["B"]);
    expect(titles(await get({ videoCodec: "av1|h264" }))).toEqual(["B", "C"]);
    expect(titles(await get({ videoCodec: "|" }))).toHaveLength(3);
    expect(titles(await get({ audioCodec: "aac" }))).toEqual(["C"]);
    expect(titles(await get({ audioCodec: "aac|truehd" }))).toEqual(["A", "C"]);
    const empty = await get({ audioCodec: "|" });
    expect(titles(empty)).toHaveLength(3);
    expect(empty.pagination.totalCount).toBe(3);
  });

  it("filters by starting letter and by the non-alpha bucket", async () => {
    const alien = await createTestMediaItem(movieLib, { title: "Alien" });
    const num = await createTestMediaItem(movieLib, { title: "1917" });
    const brazil = await createTestMediaItem(movieLib, { title: "Brazil" });
    for (const i of [alien, num, brazil]) await play(i.id);

    expect(titles(await get({ startsWith: "a" }))).toEqual(["Alien"]);
    expect(titles(await get({ startsWith: "#" }))).toEqual(["1917"]);
  });

  it("falls back to the default limit on a non-numeric value and floors at 1", async () => {
    const a = await createTestMediaItem(movieLib, { title: "A" });
    await play(a.id);
    await play(a.id, { watchedAt: new Date("2024-07-01T00:00:00Z") });

    const nan = await get({ limit: "abc" });
    expect(nan.pagination.limit).toBe(50);
    expect(nan.items).toHaveLength(2);

    const one = await get({ limit: "-5" });
    expect(one.pagination.limit).toBe(1);
    expect(one.items).toHaveLength(1);
    expect(one.pagination.hasMore).toBe(true);
    // Newest first by default.
    expect(one.items[0].watchedAt).toBe("2024-07-01T00:00:00.000Z");
  });

  it("sorts ascending with nulls last and keeps an ascending deep page plain", async () => {
    const a = await createTestMediaItem(movieLib, { title: "A" });
    await play(a.id, { watchedAt: new Date("2024-02-01T00:00:00Z") });
    await play(a.id, { watchedAt: null });
    await play(a.id, { watchedAt: new Date("2024-01-01T00:00:00Z") });

    const asc = await get({ sortOrder: "asc" });
    expect(asc.items.map((i) => i.watchedAt)).toEqual([
      "2024-01-01T00:00:00.000Z",
      "2024-02-01T00:00:00.000Z",
      null,
    ]);
  });

  it("answers a descending page past the split reach with the plain query", async () => {
    const a = await createTestMediaItem(movieLib, { title: "A" });
    await play(a.id);
    // page 60 × limit 200 reaches past SPLIT_MAX_REACH (10,000).
    const body = await get({ page: "60", limit: "200", sortBy: "deviceName" });
    expect(body.items).toEqual([]);
    expect(body.pagination.totalCount).toBe(1);
    expect(body.pagination.hasMore).toBe(false);
  });

  it("sorts descending by an item column without the split walk", async () => {
    const a = await createTestMediaItem(movieLib, { title: "A", year: 1990 });
    const b = await createTestMediaItem(movieLib, { title: "B", year: 2010 });
    await play(a.id);
    await play(b.id);
    const body = await get({ sortBy: "year" });
    expect(body.items.map((i) => i.mediaItem.title)).toEqual(["B", "A"]);
  });

  it("serialises the item's size, dates and genres", async () => {
    const lastPlayed = new Date("2024-05-05T05:05:05Z");
    const added = new Date("2023-01-01T00:00:00Z");
    const a = await createTestMediaItem(movieLib, {
      title: "Full",
      fileSize: BigInt("5000000000"),
      lastPlayedAt: lastPlayed,
      addedAt: added,
      genres: ["Drama", "Crime"],
    });
    const b = await createTestMediaItem(movieLib, { title: "Bare" });
    await play(a.id);
    await play(b.id, { watchedAt: new Date("2023-06-01T00:00:00Z") });

    const body = await get();
    const full = body.items.find((i) => i.mediaItem.title === "Full")!;
    expect(full.mediaItem.fileSize).toBe("5000000000");
    expect(full.mediaItem.lastPlayedAt).toBe(lastPlayed.toISOString());
    expect(full.mediaItem.addedAt).toBe(added.toISOString());
    expect(full.mediaItem.genres).toEqual(["Drama", "Crime"]);
    const bare = body.items.find((i) => i.mediaItem.title === "Bare")!;
    expect(bare.mediaItem.lastPlayedAt).toBeNull();
    expect(bare.mediaItem.genres).toBeNull();
  });

  it("does not list another user's plays", async () => {
    const other = await createTestUser({ username: "other" });
    const otherServer = await createTestServer(other.id);
    const otherLib = await createTestLibrary(otherServer.id, { type: "MOVIE" });
    const item = await createTestMediaItem(otherLib.id, { title: "Theirs" });
    await play(item.id, { mediaServerId: otherServer.id, serverUsername: "stranger" });
    const mine = await createTestMediaItem(movieLib, { title: "Mine" });
    await play(mine.id);
    const body = await get();
    expect(titles(body)).toEqual(["Mine"]);
    expect(body.usernames).toEqual(["alice"]);
  });
});
