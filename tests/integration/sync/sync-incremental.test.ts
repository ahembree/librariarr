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
// Jellyfin/Emby: which library an item lives in, resolved from its ancestors.
// Undefined by default, so a test that does not care behaves as a server with
// no such lookup.
const mockResolveLibraryKey = vi.fn();
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => ({
    getItemMetadata: mockGetItemMetadata,
    resolveLibraryKey: mockResolveLibraryKey,
  })),
}));

// Post-write side effects, asserted directly: a run can both write rows AND
// report `fell-back`, and skipping these leaves stale caches, stale dedup flags
// and a UI that never refreshes.
const sideEffects = vi.hoisted(() => ({
  emit: vi.fn(),
  invalidate: vi.fn(),
  // Awaited with `.catch()` by the caller, so it must resolve, not return undefined.
  recompute: vi.fn(async () => {}),
}));
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: sideEffects.emit } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: sideEffects.invalidate }));
vi.mock("@/lib/dedup/recompute-canonical", () => ({ recomputeCanonical: sideEffects.recompute }));

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

  it("falls seriesKey back to the title when the show has no series-level ids", async () => {
    // Regression: for an UNMATCHED show (show metadata carries no Guid), the
    // episode's OWN Guid is episode-level. seriesKey must NOT use it — that id is
    // per-episode and would fragment the show into one "series" per episode and
    // disagree with the persisted external ids / migration backfill (both of
    // which drop episode-level ids for series). It must fall back to the title.
    const { user } = await seed();
    const prisma = getTestPrisma();
    const server = await prisma.mediaServer.findFirstOrThrow({ where: { userId: user.id } });
    const seriesLib = await createTestLibrary(server.id, { key: "2", type: "SERIES" });

    mockGetItemMetadata.mockImplementation(async (ratingKey: string) => {
      if (ratingKey === "show-unmatched") {
        // Unmatched show: real metadata, but NO Guid (no series-level id).
        return {
          ratingKey: "show-unmatched", key: "/library/metadata/show-unmatched", type: "show",
          title: "Home Movies 1998", librarySectionID: 2,
        };
      }
      return {
        ratingKey: "ep-hm", key: "/library/metadata/ep-hm", type: "episode",
        title: "Birthday", grandparentTitle: "Home Movies 1998", grandparentRatingKey: "show-unmatched",
        parentIndex: 1, index: 1, librarySectionID: 2,
        Guid: [{ id: "tvdb://909090" }], // EPISODE-level id — must NOT become the seriesKey
      };
    });

    const result = await syncMediaServerItems(server.id, ["ep-hm"], []);
    expect(result.status).toBe("done");

    const ep = await prisma.mediaItem.findFirstOrThrow({
      where: { libraryId: seriesLib.id, ratingKey: "ep-hm" },
    });
    expect(ep.seriesKey).toBe("title:home movies 1998");
    // And no episode-level external id was persisted either (mirrors the key).
    const ids = await prisma.mediaItemExternalId.findMany({ where: { mediaItemId: ep.id } });
    expect(ids).toHaveLength(0);
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

  it("falls back when an item names a library section we have no row for", async () => {
    const { server } = await seed();
    // No existing row and a librarySectionID that matches no library. This is
    // positive evidence a NEW library appeared on the server, and only the full
    // sync creates Library rows — the one mapping failure worth escalating.
    mockGetItemMetadata.mockResolvedValue(movieMeta("m9", { librarySectionID: 999 }));

    const result = await syncMediaServerItems(server.id, ["m9"], []);

    expect(result.status).toBe("fell-back");
    expect(await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "m9" } })).toBeNull();
  });

  it("drops an item with no library section at all instead of escalating", async () => {
    const { server } = await seed();
    // Plex emits these on every routine add: a movie's extras and trailers
    // belong to no library section, so nothing can place them. Escalating to a
    // whole-server sync used to turn one added movie into ~64k item-writes —
    // and a full sync could not have stored them either.
    const sectionless = movieMeta("extra-1", { type: "clip" });
    delete (sectionless as { librarySectionID?: number }).librarySectionID;
    mockGetItemMetadata.mockResolvedValue(sectionless);

    const result = await syncMediaServerItems(server.id, ["extra-1"], []);

    expect(result.status).toBe("done");
    expect(result.unresolved).toBe(1);
    expect(result.upserted).toBe(0);
    expect(await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "extra-1" } })).toBeNull();
  });

  it("still syncs the mappable items in a batch containing an unmappable one", async () => {
    const { server } = await seed();
    // The realistic shape of a Plex add: one real item beside a pile of
    // sectionless extras. The old all-or-nothing bail threw away the real one.
    const sectionless = movieMeta("extra-1", { type: "clip" });
    delete (sectionless as { librarySectionID?: number }).librarySectionID;
    mockGetItemMetadata.mockImplementation(async (id: string) =>
      id === "m1" ? movieMeta("m1", { title: "Real Movie" }) : { ...sectionless, ratingKey: id },
    );

    const result = await syncMediaServerItems(server.id, ["m1", "extra-1", "extra-2"], []);

    expect(result.status).toBe("done");
    expect(result.upserted).toBe(1);
    expect(result.unresolved).toBe(2);
    const rows = await getTestPrisma().mediaItem.findMany({ select: { ratingKey: true } });
    expect(rows.map((r) => r.ratingKey)).toEqual(["m1"]);
  });

  it("skips an item in a disabled library without escalating", async () => {
    const { user } = await seed();
    const server2 = await createTestServer(user.id, { name: "S2" });
    await createTestLibrary(server2.id, { key: "9", type: "MOVIE", enabled: false });
    mockGetItemMetadata.mockResolvedValue(movieMeta("d1", { librarySectionID: 9 }));

    const result = await syncMediaServerItems(server2.id, ["d1"], []);

    // The full sync skips disabled libraries outright, so escalating to one was
    // pure cost: it would have done nothing with this item either.
    expect(result.status).toBe("done");
    expect(result.skippedDisabled).toBe(1);
    expect(await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "d1" } })).toBeNull();
  });

  it("DOES delete a gone item even in a disabled library", async () => {
    const { user } = await seed();
    const server2 = await createTestServer(user.id, { name: "S3" });
    const disabled = await createTestLibrary(server2.id, { key: "9", type: "MOVIE", enabled: false });
    await createTestMediaItem(disabled.id, { ratingKey: "d2" });
    // Deliberately asymmetric with the upsert path, which skips disabled
    // libraries. Nothing else would ever remove this row — the full sync skips
    // disabled libraries so its stale purge never enumerates them — while no
    // read path or rule filters on Library.enabled, so an immortal row for
    // deleted media would go on matching a "not played in N months" DELETE rule.
    mockGetItemMetadata.mockRejectedValue({ response: { status: 404 } });

    const result = await syncMediaServerItems(server2.id, ["d2"], []);

    expect(result.deleted).toBe(1);
    expect(await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "d2" } })).toBeNull();
  });

  it("does not delete on an unparseable response (only on a definite not-found)", async () => {
    const { server, library } = await seed();
    await createTestMediaItem(library.id, { ratingKey: "live-1" });
    // A proxy error page / empty body is transient, not evidence of deletion.
    mockGetItemMetadata.mockRejectedValue(new Error("Unrecognized Plex metadata response"));

    const result = await syncMediaServerItems(server.id, ["live-1"], []);

    expect(result.status).toBe("fell-back");
    expect(result.deleted).toBe(0);
    expect(await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "live-1" } })).not.toBeNull();
  });

  it("does not escalate for an item type no library could hold", async () => {
    const { server } = await seed();
    // A Plex Photos section is filtered out by getLibraries(), so it can NEVER
    // get a Library row. Escalating would enqueue a full sync that cannot fix
    // it, and the next photo would do it again — forever.
    mockGetItemMetadata.mockResolvedValue({
      ratingKey: "photo-1", type: "photo", title: "IMG_1234", librarySectionID: 5,
    });

    const result = await syncMediaServerItems(server.id, ["photo-1"], []);

    expect(result.status).toBe("done");
    expect(result.unresolved).toBe(1);
  });

  it("still escalates for a syncable item in an unknown section (a new library)", async () => {
    const { server } = await seed();
    mockGetItemMetadata.mockResolvedValue(movieMeta("m99", { librarySectionID: 999 }));

    const result = await syncMediaServerItems(server.id, ["m99"], []);

    expect(result.status).toBe("fell-back");
  });

  it("prefers the server-reported section over a stale stored row", async () => {
    const { user } = await seed();
    const server2 = await createTestServer(user.id, { name: "S4" });
    const oldLib = await createTestLibrary(server2.id, { key: "1", type: "MOVIE" });
    const newLib = await createTestLibrary(server2.id, { key: "2", type: "MOVIE" });
    await createTestMediaItem(oldLib.id, { ratingKey: "moved-1", title: "Old" });
    // The item now lives in section 2 on the server.
    mockGetItemMetadata.mockResolvedValue(movieMeta("moved-1", { title: "Moved", librarySectionID: 2 }));

    await syncMediaServerItems(server2.id, ["moved-1"], []);

    const rows = await getTestPrisma().mediaItem.findMany({ where: { ratingKey: "moved-1" } });
    expect(rows.some((r) => r.libraryId === newLib.id)).toBe(true);
  });

  it("deletes a row the server reports as gone (404)", async () => {
    const { server, library } = await seed();
    await createTestMediaItem(library.id, { ratingKey: "gone-1" });
    mockGetItemMetadata.mockRejectedValue({ response: { status: 404 } });

    const result = await syncMediaServerItems(server.id, ["gone-1"], []);

    expect(result.status).toBe("done");
    expect(result.deleted).toBe(1);
    expect(await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "gone-1" } })).toBeNull();
  });
  it("falls back on Jellyfin when an item carries no library section", async () => {
    // Jellyfin/Emby `normalizeItem` never populates `librarySectionID`, so a
    // brand-new item there has no section evidence at all. Plex drops such ids
    // (they are extras); on Jellyfin dropping them would mean newly-added media
    // never appears until the scheduled sync hours later, so it still escalates.
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "JF", type: "JELLYFIN" });
    await createTestLibrary(server.id, { key: "jf-1", type: "MOVIE" });
    const sectionless = movieMeta("jf-new", { title: "New On Jellyfin" });
    delete (sectionless as { librarySectionID?: number }).librarySectionID;
    mockGetItemMetadata.mockResolvedValue(sectionless);

    const result = await syncMediaServerItems(server.id, ["jf-new"], []);

    expect(result.status).toBe("fell-back");
    expect(result.unresolved).toBe(1);
  });
  // ── Jellyfin/Emby: placing an item the server does not label ──────────
  // Their items carry no library section, so a brand-new item used to be
  // unresolved on every add — and unresolved escalates on those servers, so
  // every single add cost a whole-server sync.

  it("places a new Jellyfin item through its ancestors instead of escalating", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "JF", type: "JELLYFIN" });
    const library = await createTestLibrary(server.id, { key: "lib-1", type: "MOVIE" });
    const item = movieMeta("jf-new", { title: "New on Jellyfin" });
    delete (item as { librarySectionID?: number }).librarySectionID;
    mockGetItemMetadata.mockResolvedValue(item);
    mockResolveLibraryKey.mockResolvedValue("lib-1");

    const result = await syncMediaServerItems(server.id, ["jf-new"], []);

    expect(result.status).toBe("done");
    expect(result.upserted).toBe(1);
    expect(result.unresolved).toBe(0);
    expect(mockResolveLibraryKey).toHaveBeenCalledWith("jf-new");
    const row = await getTestPrisma().mediaItem.findFirst({ where: { ratingKey: "jf-new" } });
    expect(row?.libraryId).toBe(library.id);
  });

  it("does not look up the library for an item it already holds", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "JF", type: "JELLYFIN" });
    const library = await createTestLibrary(server.id, { key: "lib-1", type: "MOVIE" });
    await createTestMediaItem(library.id, { ratingKey: "jf-known", title: "Old title" });
    const item = movieMeta("jf-known", { title: "Renamed" });
    delete (item as { librarySectionID?: number }).librarySectionID;
    mockGetItemMetadata.mockResolvedValue(item);

    const result = await syncMediaServerItems(server.id, ["jf-known"], []);

    expect(result.status).toBe("done");
    expect(result.upserted).toBe(1);
    expect(mockResolveLibraryKey).not.toHaveBeenCalled();
  });

  it("skips a Jellyfin show resolved into a series library without escalating", async () => {
    // One new episode makes Jellyfin report the episode, its season and its
    // show as added. The show resolves to the same library, is the wrong type
    // for it, and must be skipped — not left unresolved (a full sync).
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "JF", type: "JELLYFIN" });
    await createTestLibrary(server.id, { key: "tv-1", type: "SERIES" });
    mockGetItemMetadata.mockResolvedValue({
      ratingKey: "jf-show", key: "/Items/jf-show", type: "show", title: "A Show",
      Guid: [{ id: "tvdb://1" }],
    });
    mockResolveLibraryKey.mockResolvedValue("tv-1");

    const result = await syncMediaServerItems(server.id, ["jf-show"], []);

    expect(result.status).toBe("done");
    expect(result.upserted).toBe(0);
    expect(result.skippedNonMedia).toBe(1);
    expect(result.unresolved).toBe(0);
  });

  it("escalates when a Jellyfin item's ancestors name a library we have no row for", async () => {
    // Only a full sync creates Library rows, so a new library is the one
    // reason a placed item still warrants one.
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "JF", type: "JELLYFIN" });
    await createTestLibrary(server.id, { key: "lib-1", type: "MOVIE" });
    const item = movieMeta("jf-newlib");
    delete (item as { librarySectionID?: number }).librarySectionID;
    mockGetItemMetadata.mockResolvedValue(item);
    mockResolveLibraryKey.mockResolvedValue("lib-brand-new");

    const result = await syncMediaServerItems(server.id, ["jf-newlib"], []);

    expect(result.status).toBe("fell-back");
    expect(result.reason).toContain("no matching Library row");
  });

  it("still falls back when the ancestors lookup fails", async () => {
    // Exactly what every add used to cost — a transient failure here must be
    // no worse than before the lookup existed, and never a dropped change.
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "JF", type: "JELLYFIN" });
    await createTestLibrary(server.id, { key: "lib-1", type: "MOVIE" });
    const item = movieMeta("jf-fail");
    delete (item as { librarySectionID?: number }).librarySectionID;
    mockGetItemMetadata.mockResolvedValue(item);
    mockResolveLibraryKey.mockRejectedValue(new Error("timeout"));

    const result = await syncMediaServerItems(server.id, ["jf-fail"], []);

    expect(result.status).toBe("fell-back");
    expect(result.unresolved).toBe(1);
  });

  it("runs cache invalidation and the sync event even when it also falls back", async () => {
    const { server, library } = await seed();
    await createTestLibrary(server.id, { key: "2", type: "MOVIE" });
    // One mappable item is written; a second names an unknown section, so the
    // run reports `fell-back`. The write still happened, so the side effects
    // must too — otherwise listings serve pre-write cache entries, the dedup
    // canonical flags stay stale (the item renders twice on a multi-server
    // install), and the dashboard shelf never refreshes.
    mockGetItemMetadata.mockImplementation(async (id: string) =>
      id === "ok-1"
        ? movieMeta("ok-1", { librarySectionID: Number(library.key) })
        : movieMeta("new-lib-1", { librarySectionID: 999 }),
    );

    const result = await syncMediaServerItems(server.id, ["ok-1", "new-lib-1"], []);

    expect(result.status).toBe("fell-back");
    expect(result.upserted).toBe(1);
    expect(sideEffects.invalidate).toHaveBeenCalled();
    expect(sideEffects.recompute).toHaveBeenCalledWith(server.userId);
    expect(sideEffects.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sync:completed" }),
    );
  });

  it("skips the side effects when nothing was written", async () => {
    const { server } = await seed();
    const sectionless = movieMeta("nothing-1", { type: "clip" });
    delete (sectionless as { librarySectionID?: number }).librarySectionID;
    mockGetItemMetadata.mockResolvedValue(sectionless);

    await syncMediaServerItems(server.id, ["nothing-1"], []);

    expect(sideEffects.invalidate).not.toHaveBeenCalled();
    expect(sideEffects.emit).not.toHaveBeenCalled();
  });

  it("carries the watchlist flag forward when a ratingKey exists in two libraries", async () => {
    const { user } = await seed();
    const server2 = await createTestServer(user.id, { name: "Dup" });
    const libA = await createTestLibrary(server2.id, { key: "1", type: "MOVIE" });
    const libB = await createTestLibrary(server2.id, { key: "2", type: "MOVIE" });
    // Legal: @@unique([libraryId, ratingKey]) — one server, one key, two rows.
    const rowInA = await createTestMediaItem(libA.id, { ratingKey: "dup-1" });
    await createTestMediaItem(libB.id, { ratingKey: "dup-1" });
    await getTestPrisma().mediaItem.update({
      where: { id: rowInA.id }, data: { isWatchlisted: true },
    });
    // Plex item metadata carries no watchlist field, so the stored flag must be
    // carried forward — from the row in the library that mapping actually
    // resolved to, not abandoned because the ratingKey is ambiguous.
    mockGetItemMetadata.mockResolvedValue(movieMeta("dup-1", { librarySectionID: 1 }));

    await syncMediaServerItems(server2.id, ["dup-1"], []);

    const rowA = await getTestPrisma().mediaItem.findFirst({
      where: { ratingKey: "dup-1", libraryId: libA.id },
    });
    expect(rowA?.isWatchlisted).toBe(true);
  });
});
