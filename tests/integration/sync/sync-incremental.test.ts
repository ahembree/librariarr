import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
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

// Keep artwork-cache side effects off the filesystem.
vi.mock("@/lib/image-cache/image-cache", () => ({
  invalidateCachedUrls: vi.fn(),
  normalizeCacheUrl: (u: string | null) => u ?? "",
}));

const mockGetItemMetadata = vi.fn();
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => ({ getItemMetadata: mockGetItemMetadata })),
}));

// Import after mocks
import { syncMediaServerItems } from "@/lib/sync/sync-incremental";

const movieMeta = (ratingKey: string, over: Record<string, unknown> = {}) => ({
  ratingKey,
  key: `/library/metadata/${ratingKey}`,
  type: "movie",
  title: `Movie ${ratingKey}`,
  year: 2024,
  librarySectionID: 1,
  Guid: [{ id: "tmdb://999" }],
  ...over,
});

async function seed() {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
  return { user, server, library };
}

beforeEach(async () => {
  await cleanDatabase();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("syncMediaServerItems", () => {
  it("upserts a newly-added item", async () => {
    const { server } = await seed();
    mockGetItemMetadata.mockResolvedValue(movieMeta("m1", { title: "Brand New" }));

    const result = await syncMediaServerItems(server.id, ["m1"], []);

    expect(result.status).toBe("done");
    expect(result.upserted).toBe(1);
    const item = await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "m1" } });
    expect(item?.title).toBe("Brand New");
  });

  it("keeps play state from stored watch history instead of admin-only metadata", async () => {
    const { server, library } = await seed();
    const prisma = getTestPrisma();
    // The item sync had already recorded a play by another household member.
    const item = await createTestMediaItem(library.id, {
      ratingKey: "m-played",
      playCount: 3,
      lastPlayedAt: new Date("2025-07-01T00:00:00Z"),
    });
    await prisma.watchHistory.createMany({
      data: [
        { mediaItemId: item.id, mediaServerId: server.id, serverUsername: "roommate", watchedAt: new Date("2025-07-01T00:00:00Z") },
        { mediaItemId: item.id, mediaServerId: server.id, serverUsername: "admin", watchedAt: new Date("2023-01-01T00:00:00Z") },
        { mediaItemId: item.id, mediaServerId: server.id, serverUsername: "kid", watchedAt: new Date("2024-01-01T00:00:00Z") },
      ],
    });

    // Plex/Jellyfin only report the ADMIN account's view state on an item
    // fetch — here, one play two years ago.
    mockGetItemMetadata.mockResolvedValue(
      movieMeta("m-played", { viewCount: 1, lastViewedAt: Math.floor(Date.UTC(2023, 0, 1) / 1000) }),
    );

    const result = await syncMediaServerItems(server.id, ["m-played"], []);
    expect(result.status).toBe("done");

    const after = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "m-played" } });
    // Writing the metadata unguarded would reset this to 2023 and playCount to
    // 1, making `lastPlayedAt` (and the `seriesLastPlayedAt` aggregate built
    // from it) contradict the History page until the next full sync.
    expect(after.lastPlayedAt?.toISOString()).toBe("2025-07-01T00:00:00.000Z");
    expect(after.playCount).toBe(3);
  });

  it("keeps a Plex item's watchlist flag, which item metadata never carries", async () => {
    const { server, library } = await seed();
    const prisma = getTestPrisma();
    const item = await createTestMediaItem(library.id, { ratingKey: "m-wl" });
    await prisma.mediaItem.update({ where: { id: item.id }, data: { isWatchlisted: true } });

    // Plex exposes the watchlist only through the account-level plex.tv API the
    // full sync calls; nothing in the item payload says "watchlisted".
    mockGetItemMetadata.mockResolvedValue(movieMeta("m-wl"));

    await syncMediaServerItems(server.id, ["m-wl"], []);

    const after = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "m-wl" } });
    expect(after.isWatchlisted).toBe(true);
  });

  it("lets Jellyfin un-favourite an item, since its metadata is authoritative", async () => {
    const { user } = await seed();
    const prisma = getTestPrisma();
    const jellyfin = await prisma.mediaServer.create({
      data: {
        userId: user.id, type: "JELLYFIN", name: "Jellyfin",
        url: "http://jellyfin.test:8096", accessToken: "x", machineId: "jf-wl",
      },
    });
    const jfLibrary = await createTestLibrary(jellyfin.id, { key: "1", type: "MOVIE" });
    const item = await createTestMediaItem(jfLibrary.id, { ratingKey: "jf-wl" });
    await prisma.mediaItem.update({ where: { id: item.id }, data: { isWatchlisted: true } });

    // Jellyfin/Emby carry `IsFavorite` on the item itself — this path fetched
    // it, so it wins. Carrying the stored flag forward here would make
    // un-favouriting wait for a full sync.
    mockGetItemMetadata.mockResolvedValue(movieMeta("jf-wl", { isWatchlisted: false }));

    await syncMediaServerItems(jellyfin.id, ["jf-wl"], []);

    const after = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "jf-wl" } });
    expect(after.isWatchlisted).toBe(false);
  });

  it("falls back (never clears series external ids) when the show fetch fails", async () => {
    const { user } = await seed();
    const prisma = getTestPrisma();
    const server = await prisma.mediaServer.findFirstOrThrow({ where: { userId: user.id } });
    const seriesLib = await createTestLibrary(server.id, { key: "2", type: "SERIES" });
    const ep = await createTestMediaItem(seriesLib.id, {
      ratingKey: "ep1", type: "SERIES", title: "Ep 1",
      parentTitle: "The Show", seasonNumber: 1, episodeNumber: 1,
    });
    // The series-level id every Arr/Seerr criterion for this show hangs on.
    await prisma.mediaItemExternalId.create({
      data: { mediaItemId: ep.id, source: "TVDB", externalId: "12345" },
    });

    mockGetItemMetadata.mockImplementation(async (ratingKey: string) => {
      if (ratingKey === "show1") throw new Error("ETIMEDOUT");
      return {
        ratingKey: "ep1", key: "/library/metadata/ep1", type: "episode",
        title: "Ep 1", grandparentTitle: "The Show", grandparentRatingKey: "show1",
        parentIndex: 1, index: 1, librarySectionID: 2,
        Guid: [{ id: "tvdb://999999" }], // EPISODE-level id — must never be stored
      };
    });

    const result = await syncMediaServerItems(server.id, ["ep1"], []);

    // `processBatch` reads a missing show entry as "this show has no
    // series-level ids" and clears them, so continuing past the failure would
    // have wiped TVDB:12345 and made every Arr criterion vacuously false.
    expect(result.status).toBe("fell-back");
    const ids = await prisma.mediaItemExternalId.findMany({ where: { mediaItemId: ep.id } });
    expect(ids.map((i) => `${i.source}:${i.externalId}`)).toEqual(["TVDB:12345"]);
  });

  it("writes seriesKey from the show-level TVDB id for an episode", async () => {
    const { user } = await seed();
    const prisma = getTestPrisma();
    const server = await prisma.mediaServer.findFirstOrThrow({ where: { userId: user.id } });
    const seriesLib = await createTestLibrary(server.id, { key: "2", type: "SERIES" });

    mockGetItemMetadata.mockImplementation(async (ratingKey: string) => {
      if (ratingKey === "show-bcs") {
        // Show-level metadata carries the SERIES-level TVDB id.
        return {
          ratingKey: "show-bcs", key: "/library/metadata/show-bcs", type: "show",
          title: "Better Call Saul", librarySectionID: 2,
          Guid: [{ id: "tvdb://273181" }, { id: "tmdb://60059" }],
        };
      }
      return {
        ratingKey: "ep-bcs", key: "/library/metadata/ep-bcs", type: "episode",
        title: "Uno", grandparentTitle: "Better Call Saul", grandparentRatingKey: "show-bcs",
        parentIndex: 1, index: 1, librarySectionID: 2,
        Guid: [{ id: "tvdb://5051111" }], // EPISODE-level id — must NOT become the seriesKey
      };
    });

    const result = await syncMediaServerItems(server.id, ["ep-bcs"], []);
    expect(result.status).toBe("done");

    const ep = await prisma.mediaItem.findFirstOrThrow({
      where: { libraryId: seriesLib.id, ratingKey: "ep-bcs" },
    });
    // seriesKey uses the SHOW-level TVDB id (273181), never the episode's own id.
    expect(ep.seriesKey).toBe("tvdb:273181");
  });

  it("still writes metadata play state for an item with no stored history", async () => {
    const { server } = await seed();
    mockGetItemMetadata.mockResolvedValue(
      movieMeta("m-new", { viewCount: 2, lastViewedAt: Math.floor(Date.UTC(2026, 0, 15) / 1000) }),
    );

    await syncMediaServerItems(server.id, ["m-new"], []);

    const after = await getTestPrisma().mediaItem.findFirstOrThrow({ where: { ratingKey: "m-new" } });
    expect(after.playCount).toBe(2);
    expect(after.lastPlayedAt?.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  it("deletes items reported as removed", async () => {
    const { library } = await seed();
    await createTestMediaItem(library.id, { ratingKey: "m2", title: "Old" });

    const server = await getTestPrisma().mediaServer.findFirst({});
    const result = await syncMediaServerItems(server!.id, [], ["m2"]);

    expect(result.status).toBe("done");
    expect(result.deleted).toBe(1);
    expect(await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "m2" } })).toBeNull();
  });

  it("treats a changed id the server 404s as a deletion", async () => {
    const { server, library } = await seed();
    await createTestMediaItem(library.id, { ratingKey: "m3" });
    mockGetItemMetadata.mockRejectedValue({ response: { status: 404 } });

    const result = await syncMediaServerItems(server.id, ["m3"], []);

    expect(result.status).toBe("done");
    expect(result.deleted).toBe(1);
    expect(await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "m3" } })).toBeNull();
  });

  it("falls back (never deletes) on a transient fetch error", async () => {
    const { server, library } = await seed();
    await createTestMediaItem(library.id, { ratingKey: "m4" });
    mockGetItemMetadata.mockRejectedValue({ response: { status: 500 } });

    const result = await syncMediaServerItems(server.id, ["m4"], []);

    expect(result.status).toBe("fell-back");
    // The item must NOT have been deleted on a transient error.
    expect(await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "m4" } })).not.toBeNull();
  });

  it("skips when a full sync is already running for the server", async () => {
    const { server } = await seed();
    await getTestPrisma().syncJob.create({
      data: { mediaServerId: server.id, status: "RUNNING" },
    });

    const result = await syncMediaServerItems(server.id, ["m1"], []);

    expect(result.status).toBe("skipped");
    expect(mockGetItemMetadata).not.toHaveBeenCalled();
  });

  it("falls back without fetching when the change set exceeds the threshold", async () => {
    const { server } = await seed();
    const many = Array.from({ length: 150 }, (_, i) => `x${i}`);

    const result = await syncMediaServerItems(server.id, many, []);

    expect(result.status).toBe("fell-back");
    expect(mockGetItemMetadata).not.toHaveBeenCalled();
  });

  it("never stores a collection as a media item", async () => {
    // Librariarr creates Plex collections itself, and the server reports that
    // write back as a library change — so without this guard the app's own
    // collections round-trip in as phantom movies. A collection maps cleanly
    // to a known library, so nothing else would stop it.
    const { server } = await seed();
    mockGetItemMetadata.mockResolvedValue(
      movieMeta("coll-1", { type: "collection", title: "Leaving Soon" })
    );

    const result = await syncMediaServerItems(server.id, ["coll-1"], []);

    expect(result.status).toBe("done");
    expect(result.upserted).toBe(0);
    expect(
      await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "coll-1" } })
    ).toBeNull();
  });

  it("cleans up a phantom row for an item that turns out to be a collection", async () => {
    // Self-healing for rows synced before the guard existed: nothing
    // legitimate shares a container's ratingKey, so the row is removed rather
    // than waiting for the next full sync's stale-item purge.
    const { server, library } = await seed();
    await createTestMediaItem(library.id, { ratingKey: "coll-2", title: "Leaving Soon" });
    mockGetItemMetadata.mockResolvedValue(
      movieMeta("coll-2", { type: "collection", title: "Leaving Soon" })
    );

    const result = await syncMediaServerItems(server.id, ["coll-2"], []);

    expect(result.status).toBe("done");
    expect(result.deleted).toBe(1);
    expect(
      await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "coll-2" } })
    ).toBeNull();
  });

  it("never stores a show or season as an episode row", async () => {
    // A Plex timeline burst for a new episode also carries the show (type 2)
    // and season (type 3) rating keys, and Jellyfin's LibraryChanged.ItemsAdded
    // does the same. Those are not containers, so the collection guard doesn't
    // catch them — but the full sync only ever stores episodes in a SERIES
    // library, so storing them here creates a phantom row that the next full
    // sync purges anyway.
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { key: "2", type: "SERIES" });

    mockGetItemMetadata.mockImplementation(async (id: string) =>
      id === "ep-1"
        ? {
            ratingKey: "ep-1",
            key: "/library/metadata/ep-1",
            type: "episode",
            title: "Pilot",
            parentIndex: 1,
            index: 1,
            grandparentTitle: "Breaking Bad",
            librarySectionID: 2,
          }
        : {
            ratingKey: id,
            key: `/library/metadata/${id}`,
            type: id === "show-1" ? "show" : "season",
            title: "Breaking Bad",
            librarySectionID: 2,
          }
    );

    const result = await syncMediaServerItems(server.id, ["show-1", "season-1", "ep-1"], []);

    expect(result.status).toBe("done");
    // Only the episode is real library media.
    expect(result.upserted).toBe(1);
    const rows = await getTestPrisma().mediaItem.findMany({ select: { ratingKey: true } });
    expect(rows.map((r) => r.ratingKey)).toEqual(["ep-1"]);
  });

  it("falls back when a new item can't be mapped to a known library", async () => {
    const { server } = await seed();
    // No existing row and a librarySectionID that matches no library.
    mockGetItemMetadata.mockResolvedValue(movieMeta("m9", { librarySectionID: 999 }));

    const result = await syncMediaServerItems(server.id, ["m9"], []);

    expect(result.status).toBe("fell-back");
    expect(await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "m9" } })).toBeNull();
  });
});
