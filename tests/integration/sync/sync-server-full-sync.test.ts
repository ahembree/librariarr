/**
 * The full sync (`syncMediaServer`) end to end against the real database, with
 * a scriptable fake media-server client. Covers the paths the mocked-prisma
 * unit tests cannot judge because they never run the SQL:
 *
 *  - SERIES libraries: show-level genres, series-level external ids and
 *    `seriesKey`, and the show summary reaching episodes the enrichment skipped;
 *  - MUSIC libraries: the artist's MusicBrainz id written onto its tracks;
 *  - rich movie metadata, streams and external ids persisted as stored columns;
 *  - artwork invalidation when an item's artwork changes;
 *  - monotonic play state across a sync whose sources read zero;
 *  - a Stop between upsert batches, a library disabled mid-sync, and a total-less
 *    listing that must never be read as "the library is empty";
 *  - the stale-purge confirmation through `resolveLibraryKey` (Jellyfin/Emby);
 *  - the vanished-library purge with its cascaded exceptions;
 *  - the failure path's error text and the non-fatal side phases.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
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
vi.mock("@/lib/image-cache/image-cache", () => ({
  invalidateCachedUrls: vi.fn(async () => {}),
  normalizeCacheUrl: (u: string | null) => u ?? "",
}));
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));
vi.mock("@/lib/dedup/recompute-canonical", () => ({ recomputeCanonical: vi.fn(async () => {}) }));
vi.mock("@/lib/sync/sync-watch-history", () => ({ syncWatchHistory: vi.fn(async () => ({ count: 0 })) }));

type Item = Record<string, unknown> & { ratingKey: string };
type Lib = { key: string; title: string; type: string };

const fake = vi.hoisted(() => ({
  plex: false,
  bulkListingIncomplete: false,
  libraries: [] as Array<{ key: string; title: string; type: string }>,
  /** Section key → its full catalogue. */
  catalog: {} as Record<string, Array<Record<string, unknown> & { ratingKey: string }>>,
  /** Section key → total to report (`null` = unknown); defaults to the catalogue length. */
  totals: {} as Record<string, number | null>,
  shows: [] as Array<Record<string, unknown>>,
  artists: [] as Array<Record<string, unknown>> | null,
  watchlist: null as Set<string> | null,
  watchCounts: new Map<string, { count: number; lastWatchedAt: number }>(),
  /** ratingKey → per-item metadata (a function may throw). */
  metadata: {} as Record<string, unknown>,
  resolveLibraryKey: null as null | ((rk: string) => Promise<string | null>),
  getLibrariesError: null as unknown,
  onWatchCounts: null as null | (() => Promise<void> | void),
  onPage: null as null | ((offset: number) => Promise<void> | void),
}));

vi.mock("@/lib/media-server/factory", async () => {
  const { MediaItemNotFoundError } = await import("@/lib/media-server/client");
  const { PlexClient } = await import("@/lib/plex/client");
  return {
    createMediaServerClient: vi.fn(() => {
      const methods: Record<string, unknown> = {
        bulkListingIncomplete: fake.bulkListingIncomplete,
        testConnection: async () => ({ ok: true }),
        getLibraries: async () => {
          if (fake.getLibrariesError) throw fake.getLibrariesError;
          return fake.libraries;
        },
        getWatchCounts: async () => {
          if (fake.onWatchCounts) await fake.onWatchCounts();
          return new Map(fake.watchCounts);
        },
        getLibraryShows: async () => fake.shows,
        getLibraryItemsPage: async (section: string, _t: string, offset: number, limit: number) => {
          if (fake.onPage) await fake.onPage(offset);
          const all = fake.catalog[section] ?? [];
          const total = section in fake.totals ? fake.totals[section] : all.length;
          return { items: all.slice(offset, offset + limit).map((i) => structuredClone(i)), total };
        },
        getItemMetadata: async (rk: string) => {
          const m = fake.metadata[rk];
          if (typeof m === "function") return (m as () => unknown)();
          if (m) return structuredClone(m);
          for (const items of Object.values(fake.catalog)) {
            const hit = items.find((i) => i.ratingKey === rk);
            if (hit) return structuredClone(hit);
          }
          throw new MediaItemNotFoundError(rk);
        },
      };
      if (fake.artists) methods.getLibraryArtists = async () => fake.artists;
      if (fake.resolveLibraryKey) methods.resolveLibraryKey = fake.resolveLibraryKey;
      if (fake.plex) {
        methods.getWatchlistGuids = async () => fake.watchlist;
        return Object.assign(Object.create(PlexClient.prototype), methods);
      }
      return methods;
    }),
  };
});

import { syncMediaServer, processBatch } from "@/lib/sync/sync-server";
import { invalidateCachedUrls } from "@/lib/image-cache/image-cache";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { recomputeCanonical } from "@/lib/dedup/recompute-canonical";
import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import { eventBus } from "@/lib/events/event-bus";

const prisma = getTestPrisma();
const MBID_ARTIST = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";

function movie(rk: string, extra: Record<string, unknown> = {}): Item {
  return { ratingKey: rk, key: `/library/metadata/${rk}`, type: "movie", title: `Movie ${rk}`, year: 2000, librarySectionID: 1, ...extra };
}

function setLibraries(...libs: Lib[]) {
  fake.libraries = libs;
}

async function latestJob(serverId: string) {
  return prisma.syncJob.findFirstOrThrow({ where: { mediaServerId: serverId }, orderBy: { startedAt: "desc" } });
}

async function newServer(type: "PLEX" | "JELLYFIN" = "PLEX") {
  const user = await createTestUser();
  const server = await createTestServer(user.id, { type });
  return { user, server };
}

beforeEach(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.lifecycleException.deleteMany();
  await cleanDatabase();
  vi.clearAllMocks();
  Object.assign(fake, {
    plex: false,
    bulkListingIncomplete: false,
    libraries: [],
    catalog: {},
    totals: {},
    shows: [],
    artists: null,
    watchlist: null,
    watchCounts: new Map(),
    metadata: {},
    resolveLibraryKey: null,
    getLibrariesError: null,
    onWatchCounts: null,
    onPage: null,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { gc?: unknown }).gc;
});
afterAll(async () => {
  await prisma.watchHistory.deleteMany();
  await prisma.lifecycleException.deleteMany();
  await cleanDatabase();
  await disconnectTestDb();
});

describe("SERIES libraries", () => {
  function episode(rk: string, show: string, s: number, e: number, extra: Record<string, unknown> = {}): Item {
    return {
      ratingKey: rk, key: `/library/metadata/${rk}`, type: "episode", title: `Ep ${rk}`,
      grandparentRatingKey: show, grandparentTitle: `Show ${show}`, parentIndex: s, index: e,
      librarySectionID: 2, Guid: [{ id: `tvdb://ep-${rk}` }], updatedAt: 1_700_000_000, ...extra,
    };
  }

  it("files episodes under their show's genres, series-level ids and summary", async () => {
    const { server } = await newServer();
    setLibraries({ key: "2", title: "TV", type: "show" });
    fake.shows = [
      { ratingKey: "s1", title: "Show s1", Genre: [{ tag: "Drama" }], Guid: [{ id: "tvdb://81189" }, { id: "imdb://tt0903747" }], summary: "A teacher." },
      { ratingKey: "s2", title: "Show s2" },
      // A show without a rating key cannot be matched to anything — ignored.
      { title: "Orphan", Genre: [{ tag: "Ignored" }], summary: "x" },
    ];
    fake.catalog["2"] = [
      episode("e1", "s1", 1, 1),
      episode("e2", "s1", 1, 2, { Genre: [{ tag: "Own Genre" }] }),
      episode("e3", "s2", 1, 1),
    ];

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    const rows = await prisma.mediaItem.findMany({ include: { externalIds: true }, orderBy: { ratingKey: "asc" } });
    const [e1, e2, e3] = rows;
    expect(e1.type).toBe("SERIES");
    expect(e1.genres).toEqual(["Drama"]);
    expect(e2.genres).toEqual(["Own Genre"]);
    expect(e1.parentTitle).toBe("Show s1");
    expect(e1.seasonNumber).toBe(1);
    expect(e1.episodeNumber).toBe(1);
    expect(e1.parentSummary).toBe("A teacher.");
    expect(e1.seriesKey).toBe("tvdb:81189");
    // The SERIES id, never the episode's own one.
    expect(e1.externalIds.map((x) => [x.source, x.externalId]).sort()).toEqual([
      ["IMDB", "tt0903747"], ["TVDB", "81189"],
    ]);
    // A show with no series-level ids stores none, rather than the episode's id.
    expect(e3.externalIds).toEqual([]);
    expect(e3.seriesKey).toBe("title:show s2");
    expect(e3.genres).toBeNull();
    expect((await latestJob(server.id)).status).toBe("COMPLETED");
  });

  it("refreshes every show's summary on its own episodes in one pass, and only in this library", async () => {
    const { server } = await newServer();
    fake.bulkListingIncomplete = true;
    setLibraries({ key: "2", title: "TV", type: "show" });
    fake.shows = [
      { ratingKey: "s1", summary: "One." },
      { ratingKey: "s2", summary: "Two." },
      { ratingKey: "s3", summary: "Three." },
    ];
    fake.catalog["2"] = [episode("e1", "s1", 1, 1), episode("e2", "s1", 1, 2), episode("e3", "s2", 1, 1), episode("e4", "s3", 1, 1)];
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    // Another library on the server holding an episode under the same show key.
    const other = await createTestLibrary(server.id, { key: "9", type: "SERIES" });
    const x1 = await createTestMediaItem(other.id, { ratingKey: "x1", type: "SERIES", title: "X" });
    await prisma.mediaItem.update({ where: { id: x1.id }, data: { grandparentRatingKey: "s1", parentSummary: "Elsewhere." } });

    // Episodes unchanged (not enriched, not upserted); two summaries changed.
    fake.shows = [
      { ratingKey: "s1", summary: "One, rewritten." },
      { ratingKey: "s2", summary: "Two, rewritten." },
      { ratingKey: "s3", summary: "Three." },
    ];
    // Scoped to the TV library, so the vanished-library purge leaves "9" alone.
    await syncMediaServer(server.id, "2", { skipWatchHistory: true });

    const summaries = Object.fromEntries(
      (await prisma.mediaItem.findMany()).map((r) => [r.ratingKey, r.parentSummary]),
    );
    expect(summaries).toEqual({
      e1: "One, rewritten.",
      e2: "One, rewritten.",
      e3: "Two, rewritten.",
      e4: "Three.",
      x1: "Elsewhere.",
    });
  });

  it("names the library types it touched on sync:completed", async () => {
    const { server, user } = await newServer();
    setLibraries({ key: "2", title: "TV", type: "show" }, { key: "1", title: "Movies", type: "movie" });
    fake.catalog["2"] = [episode("e1", "s1", 1, 1)];
    fake.catalog["1"] = [movie("m1")];

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect(eventBus.emit).toHaveBeenLastCalledWith({
      type: "sync:completed",
      userId: user.id,
      meta: { serverId: server.id, libraryTypes: ["MOVIE", "SERIES"] },
    });

    // A library-scoped run names only its own library's type.
    vi.mocked(eventBus.emit).mockClear();
    await syncMediaServer(server.id, "1", { skipWatchHistory: true });
    expect(eventBus.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "sync:completed", meta: { serverId: server.id, libraryTypes: ["MOVIE"] } }),
    );

    // Unless it runs the watch-history pass, which writes plays for every
    // library on the server.
    vi.mocked(eventBus.emit).mockClear();
    await syncMediaServer(server.id, "1");
    expect(eventBus.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "sync:completed", meta: { serverId: server.id, libraryTypes: ["MOVIE", "SERIES"] } }),
    );
  });

  it("names every type when a library-scoped run's reconcile repairs another library", async () => {
    const { server } = await newServer();
    setLibraries({ key: "2", title: "TV", type: "show" }, { key: "1", title: "Movies", type: "movie" });
    fake.catalog["2"] = [episode("e1", "s1", 1, 1)];
    fake.catalog["1"] = [movie("m1")];
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    // A stored play the episode's columns do not reflect yet (a reconcile an
    // earlier run did not finish): the Movies-only run repairs it.
    const ep = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "e1" } });
    await prisma.watchHistory.create({
      data: { mediaItemId: ep.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: new Date() },
    });
    vi.mocked(eventBus.emit).mockClear();
    await syncMediaServer(server.id, "1", { skipWatchHistory: true });

    expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id: ep.id } })).playCount).toBe(1);
    expect(eventBus.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "sync:completed", meta: { serverId: server.id, libraryTypes: ["MOVIE", "SERIES"] } }),
    );
  });

  it("omits the library types when the run touched no library", async () => {
    const { server } = await newServer();
    setLibraries();

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect(eventBus.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "sync:completed", meta: { serverId: server.id } }),
    );
  });

  it("clears a stored series id once the show loses its ids, and refreshes the summary on episodes enrichment skipped", async () => {
    const { server } = await newServer();
    fake.bulkListingIncomplete = true;
    setLibraries({ key: "2", title: "TV", type: "show" });
    fake.shows = [{ ratingKey: "s1", Guid: [{ id: "tvdb://81189" }], summary: "Old summary." }];
    fake.catalog["2"] = [episode("e1", "s1", 1, 1)];
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    expect(await prisma.mediaItemExternalId.count()).toBe(1);

    // Unchanged episode (same updatedAt) → not enriched, not upserted. The show
    // summary still has to reach it.
    fake.shows = [{ ratingKey: "s1", Guid: [{ id: "tvdb://81189" }], summary: "New summary." }];
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    expect((await prisma.mediaItem.findFirstOrThrow()).parentSummary).toBe("New summary.");

    // Changed episode, and the show has lost its ids: the stale series id goes.
    fake.shows = [{ ratingKey: "s1", summary: "New summary." }];
    fake.catalog["2"] = [episode("e1", "s1", 1, 1, { updatedAt: 1_800_000_000 })];
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    expect(await prisma.mediaItemExternalId.count()).toBe(0);
    expect(await prisma.mediaItem.count()).toBe(1);
  });
});

describe("MUSIC libraries", () => {
  it("writes the artist's MusicBrainz id onto its tracks and keeps the track's own", async () => {
    const { server } = await newServer();
    setLibraries({ key: "3", title: "Music", type: "artist" });
    fake.artists = [
      { ratingKey: "a1", Guid: [{ id: `mbid://${MBID_ARTIST}` }] },
      { ratingKey: "a2", Guid: [{ id: "mbid://not-an-mbid" }] },
      { Guid: [{ id: `mbid://${MBID_ARTIST}` }] },
    ];
    const trackMbid = "11111111-2222-3333-4444-555555555555";
    fake.catalog["3"] = [
      { ratingKey: "t1", key: "/t1", type: "track", title: "Song", grandparentRatingKey: "a1", grandparentTitle: "Artist", parentTitle: "Album", Guid: [{ id: `mbid://${trackMbid}` }] },
      { ratingKey: "t2", key: "/t2", type: "track", title: "Other", grandparentRatingKey: "a2", grandparentTitle: "Nobody" },
    ];

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    const t1 = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "t1" }, include: { externalIds: true } });
    expect(t1.type).toBe("MUSIC");
    expect(t1.albumTitle).toBe("Album");
    expect(t1.parentTitle).toBe("Artist");
    expect(Object.fromEntries(t1.externalIds.map((x) => [x.source, x.externalId]))).toEqual({
      MBID: trackMbid, MUSICBRAINZ: MBID_ARTIST,
    });
    const t2 = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "t2" }, include: { externalIds: true } });
    expect(t2.externalIds).toEqual([]);
    expect(t2.albumTitle).toBeNull();
  });
});

describe("movie metadata", () => {
  it("persists rich metadata, streams and de-duplicated external ids", async () => {
    const { server } = await newServer();
    setLibraries({ key: "1", title: "Movies", type: "movie" });
    fake.catalog["1"] = [movie("m1", {
      titleSort: "Matrix, The",
      originallyAvailableAt: "1999-03-31",
      addedAt: 1_600_000_000,
      Genre: [{ tag: "Sci-Fi" }],
      Director: [{ tag: "Lana" }],
      Writer: [{ tag: "Lilly" }],
      Role: [{ tag: "Keanu", role: "Neo", thumb: "/neo.jpg" }, { tag: "Extra" }],
      Country: [{ tag: "USA" }],
      Label: [{ tag: "keep" }],
      Guid: [{ id: "tmdb://603" }, { id: "tmdb://999" }, { id: "garbage" }, { id: "imdb://tt0133093" }],
      Media: [{
        id: 1, aspectRatio: 2.35, container: "mkv", bitrate: 20000,
        Part: [{
          id: 1, key: "/p", file: "/movies/The.Matrix.1999.2160p.DV.TrueHD.Atmos.mkv", size: 50_000_000_000,
          Stream: [
            { id: 1, streamType: 1, codec: "hevc", width: 3840, height: 2160, bitDepth: 10, videoRangeType: "DOVI" },
            { id: 2, streamType: 2, codec: "truehd", channels: 8, language: "English", displayTitle: "TrueHD Atmos 7.1" },
            { id: 3, streamType: 3, codec: "srt", language: "English", forced: true },
            { id: 4, streamType: 4, codec: "lyrics" },
          ],
        }],
      }],
    })];

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    const m = await prisma.mediaItem.findFirstOrThrow({ include: { externalIds: true, streams: true } });
    expect(m).toMatchObject({
      titleSort: "Matrix, The",
      genres: ["Sci-Fi"],
      directors: ["Lana"],
      writers: ["Lilly"],
      countries: ["USA"],
      labels: ["keep"],
      aspectRatio: "2.35",
      container: "mkv",
      dynamicRange: "Dolby Vision",
      audioProfile: "Dolby Atmos",
      videoBitDepth: 10,
      filePath: "/movies/The.Matrix.1999.2160p.DV.TrueHD.Atmos.mkv",
    });
    expect(m.roles).toEqual([
      { tag: "Keanu", role: "Neo", thumb: "/neo.jpg" },
      { tag: "Extra", role: null, thumb: null },
    ]);
    expect(m.fileSize).toBe(BigInt(50_000_000_000));
    expect(m.originallyAvailableAt?.toISOString().slice(0, 10)).toBe("1999-03-31");
    expect(m.addedAt?.getTime()).toBe(1_600_000_000_000);
    // The first id per source wins; a malformed guid is ignored.
    expect(Object.fromEntries(m.externalIds.map((x) => [x.source, x.externalId]))).toEqual({
      TMDB: "603", IMDB: "tt0133093",
    });
    // Video, audio and subtitle streams only.
    expect(m.streams.map((s) => s.streamType).sort()).toEqual([1, 2, 3]);
  });

  it("invalidates the cached artwork an item no longer uses, scoped to its library", async () => {
    const { server } = await newServer();
    setLibraries({ key: "1", title: "Movies", type: "movie" });
    fake.catalog["1"] = [movie("m1", { thumb: "/t/1", grandparentThumb: "/g/1", parentThumb: "/p/1" })];
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    expect(invalidateCachedUrls).not.toHaveBeenCalled();

    fake.catalog["1"] = [movie("m1", { thumb: "/t/2", grandparentThumb: "/g/2", parentThumb: "/p/2" })];
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    const lib = await prisma.library.findFirstOrThrow();
    expect(invalidateCachedUrls).toHaveBeenCalledWith(lib.id, ["/t/1", "/g/1", "/p/1"]);
  });

  it("flags an item on the Plex watchlist by any of its external ids", async () => {
    const { server } = await newServer();
    fake.plex = true;
    fake.watchlist = new Set(["imdb://tt0133093"]);
    setLibraries({ key: "1", title: "Movies", type: "movie" });
    fake.catalog["1"] = [
      movie("m1", { Guid: [{ id: "tmdb://603" }, { id: "imdb://tt0133093" }] }),
      movie("m2", { Guid: [{ id: "tmdb://604" }] }),
    ];
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    const rows = await prisma.mediaItem.findMany({ orderBy: { ratingKey: "asc" } });
    expect(rows.map((r) => r.isWatchlisted)).toEqual([true, false]);
  });
});

describe("play state stays monotonic", () => {
  it("never lowers playCount/lastPlayedAt when the server and history read zero, and raises it from the stored plays", async () => {
    const { server } = await newServer();
    setLibraries({ key: "1", title: "Movies", type: "movie" });
    fake.catalog["1"] = [movie("m1"), movie("m2")];
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    const lastPlayed = new Date("2025-05-05T00:00:00Z");
    await prisma.mediaItem.updateMany({ where: { ratingKey: "m1" }, data: { playCount: 5, lastPlayedAt: lastPlayed } });
    const m2Row = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "m2" } });
    await prisma.watchHistory.createMany({
      data: [1_749_000_000, 1_749_500_000, 1_750_000_000].map((s) => ({
        mediaItemId: m2Row.id,
        mediaServerId: server.id,
        serverUsername: "alice",
        watchedAt: new Date(s * 1000),
      })),
    });
    // The watch-history pass is mocked out here, so nothing reconciles after
    // the upsert: the 3 plays can only arrive through the counts the upsert
    // itself reads from the stored history.
    await syncMediaServer(server.id);

    const m1 = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "m1" } });
    expect(m1.playCount).toBe(5);
    expect(m1.lastPlayedAt).toEqual(lastPlayed);
    const m2 = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "m2" } });
    expect(m2.playCount).toBe(3);
    expect(m2.lastPlayedAt?.getTime()).toBe(1_750_000_000_000);
  });

  it("reads play counts per library, never from a live scan of the server's history", async () => {
    const { server } = await newServer();
    setLibraries({ key: "1", title: "Movies", type: "movie" }, { key: "2", title: "More Movies", type: "movie" });
    // The same rating key in two libraries: plays of one must not count for the other.
    fake.catalog["1"] = [movie("same")];
    fake.catalog["2"] = [movie("same", { librarySectionID: 2 })];
    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });
    const first = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "same", library: { key: "1" } } });
    await prisma.watchHistory.createMany({
      data: [1, 2].map((n) => ({
        mediaItemId: first.id,
        mediaServerId: server.id,
        serverUsername: "alice",
        watchedAt: new Date(Date.UTC(2025, 0, n)),
      })),
    });
    fake.watchCounts = new Map([["same", { count: 99, lastWatchedAt: 1_800_000_000 }]]);

    await syncMediaServer(server.id);

    const rows = await prisma.mediaItem.findMany({ where: { ratingKey: "same" }, include: { library: true } });
    const byLibrary = new Map(rows.map((r) => [r.library.key, r.playCount]));
    expect(byLibrary).toEqual(new Map([["1", 2], ["2", 0]]));
  });
});

describe("traversal and cancellation", () => {
  it("honours a Stop between upsert batches and purges nothing", async () => {
    const { server, user } = await newServer();
    setLibraries({ key: "1", title: "Movies", type: "movie" });
    const lib = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
    const old = await createTestMediaItem(lib.id, { ratingKey: "old", title: "Old" });
    fake.catalog["1"] = Array.from({ length: 300 }, (_, i) => movie(`m${String(i).padStart(3, "0")}`));
    fake.onPage = async () => {
      await prisma.syncJob.updateMany({ where: { mediaServerId: server.id }, data: { cancelRequested: true } });
    };

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    const job = await latestJob(server.id);
    expect(job.status).toBe("CANCELLED");
    // The check runs every five batches of 50 once something was written.
    expect(job.itemsProcessed).toBe(250);
    expect(await prisma.mediaItem.count({ where: { id: old.id } })).toBe(1);
    // Items were written, so listings must refresh.
    expect(eventBus.emit).toHaveBeenLastCalledWith(expect.objectContaining({ type: "sync:completed", userId: user.id }));
    expect(invalidateMediaCaches).toHaveBeenCalled();
  });

  it("skips a library disabled after the sync started instead of writing to it", async () => {
    const { server } = await newServer();
    setLibraries({ key: "1", title: "Movies", type: "movie" });
    const lib = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
    const kept = await createTestMediaItem(lib.id, { ratingKey: "kept", title: "Kept" });
    fake.catalog["1"] = [movie("m1")];
    // The first page is fetched before the library row is upserted.
    fake.onPage = async () => {
      await prisma.library.update({ where: { id: lib.id }, data: { enabled: false } });
    };

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect((await prisma.mediaItem.findMany()).map((m) => m.id)).toEqual([kept.id]);
    expect((await latestJob(server.id)).status).toBe("COMPLETED");
  });

  it("pages past a full page when the server reports no total, and purges once the empty page ends the listing", async () => {
    const { server } = await newServer();
    setLibraries({ key: "1", title: "Movies", type: "movie" });
    const lib = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
    await createTestMediaItem(lib.id, { ratingKey: "gone", title: "Gone" });
    fake.catalog["1"] = Array.from({ length: 500 }, (_, i) => movie(`m${String(i).padStart(3, "0")}`));
    fake.totals["1"] = null;
    const offsets: number[] = [];
    fake.onPage = (offset) => { offsets.push(offset); };

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect(offsets).toEqual([0, 500]);
    expect(await prisma.mediaItem.count()).toBe(500);
    expect(await prisma.mediaItem.count({ where: { ratingKey: "gone" } })).toBe(0);
  });

  it("never purges when an empty listing comes back with no total", async () => {
    const { server } = await newServer();
    setLibraries({ key: "1", title: "Movies", type: "movie" });
    const lib = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
    await createTestMediaItem(lib.id, { ratingKey: "stored", title: "Stored" });
    fake.catalog["1"] = [];
    fake.totals["1"] = null;

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect(await prisma.mediaItem.count()).toBe(1);
    expect((await latestJob(server.id)).status).toBe("COMPLETED");
  });

  it("enriches more items than one concurrency chunk", async () => {
    const { server } = await newServer();
    fake.bulkListingIncomplete = true;
    setLibraries({ key: "1", title: "Movies", type: "movie" });
    fake.catalog["1"] = Array.from({ length: 23 }, (_, i) => movie(`m${i}`, { updatedAt: 1_700_000_000 }));
    for (const m of fake.catalog["1"]) fake.metadata[m.ratingKey] = { ...m, summary: `Detail ${m.ratingKey}` };

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    const rows = await prisma.mediaItem.findMany();
    expect(rows).toHaveLength(23);
    expect(rows.every((r) => r.summary === `Detail ${r.ratingKey}`)).toBe(true);
  });
});

describe("stale candidates confirmed through resolveLibraryKey", () => {
  it("deletes only candidates the server places in another library", async () => {
    const { server } = await newServer("JELLYFIN");
    setLibraries({ key: "lib-a", title: "Movies", type: "movie" });
    const lib = await createTestLibrary(server.id, { key: "lib-a", type: "MOVIE" });
    for (const rk of ["moved", "here", "unknown", "throws"]) {
      await createTestMediaItem(lib.id, { ratingKey: rk, title: rk });
    }
    const noSection = (rk: string) => ({ ratingKey: rk, key: rk, type: "movie", title: rk });
    fake.catalog["lib-a"] = [noSection("listed")];
    for (const rk of ["moved", "here", "unknown", "throws"]) fake.metadata[rk] = noSection(rk);
    fake.resolveLibraryKey = async (rk) => {
      if (rk === "moved") return "lib-b";
      if (rk === "here") return "lib-a";
      if (rk === "unknown") return null;
      throw new Error("ancestors lookup failed");
    };

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    const left = (await prisma.mediaItem.findMany()).map((m) => m.ratingKey).sort();
    expect(left).toEqual(["here", "listed", "throws", "unknown"]);
  });

  it("keeps a candidate the server still has when the client cannot place items", async () => {
    const { server } = await newServer("JELLYFIN");
    setLibraries({ key: "lib-a", title: "Movies", type: "movie" });
    const lib = await createTestLibrary(server.id, { key: "lib-a", type: "MOVIE" });
    await createTestMediaItem(lib.id, { ratingKey: "skipped", title: "Skipped" });
    fake.catalog["lib-a"] = [{ ratingKey: "listed", key: "l", type: "movie", title: "Listed" }];
    fake.metadata.skipped = { ratingKey: "skipped", key: "s", type: "movie", title: "Skipped" };

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect(await prisma.mediaItem.count({ where: { ratingKey: "skipped" } })).toBe(1);
  });
});

describe("vanished libraries", () => {
  it("removes a library the server stopped listing, its artwork and the exceptions under it", async () => {
    const { server, user } = await newServer();
    setLibraries({ key: "1", title: "Movies", type: "movie" });
    fake.catalog["1"] = [movie("m1")];
    const gone = await createTestLibrary(server.id, { key: "9", type: "MOVIE" });
    const item = await createTestMediaItem(gone.id, { ratingKey: "x", title: "X" });
    await prisma.mediaItem.update({ where: { id: item.id }, data: { thumbUrl: "/thumb/x" } });
    await prisma.lifecycleException.create({ data: { mediaItemId: item.id, userId: user.id, reason: "keep" } });

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect(await prisma.library.count({ where: { id: gone.id } })).toBe(0);
    expect(await prisma.lifecycleException.count()).toBe(0);
    expect(invalidateCachedUrls).toHaveBeenCalledWith(gone.id, ["/thumb/x", null, null]);
  });
});

describe("failure handling", () => {
  function axiosError(status: number | undefined, data: unknown, url = "/library/sections") {
    const config = { url, method: "get", headers: new AxiosHeaders() };
    const response = status === undefined ? undefined : {
      status, statusText: "", data, headers: {}, config,
    };
    return new AxiosError("Request failed", "ERR_BAD_RESPONSE", config, undefined, response as never);
  }

  it.each([
    ["a string body", axiosError(500, "Internal boom"), "HTTP 500 (GET /library/sections): Internal boom"],
    ["a message field", axiosError(401, { message: "Unauthorized token" }), "HTTP 401 (GET /library/sections): Unauthorized token"],
    ["a Message field", axiosError(503, { Message: "Busy" }), "HTTP 503 (GET /library/sections): Busy"],
    ["a title field", axiosError(400, { title: "Bad" }), "HTTP 400 (GET /library/sections): Bad"],
    ["a Title field", axiosError(400, { Title: "Worse" }), "HTTP 400 (GET /library/sections): Worse"],
    ["an unrecognised body", axiosError(422, { code: 7 }), 'HTTP 422 (GET /library/sections): {"code":7}'],
    ["no body", axiosError(502, ""), "HTTP 502 (GET /library/sections): Request failed"],
    ["no URL", axiosError(500, "x", ""), "HTTP 500: x"],
    ["no response", axiosError(undefined, null), "Request failed"],
    ["a non-Error throw", "just a string", "Unknown error"],
  ])("records a readable error for %s", async (_label, error, expected) => {
    const { server, user } = await newServer();
    fake.getLibrariesError = error;

    await expect(syncMediaServer(server.id)).rejects.toBe(error);

    const job = await latestJob(server.id);
    expect(job.status).toBe("FAILED");
    expect(job.error).toBe(expected);
    expect(eventBus.emit).toHaveBeenLastCalledWith(expect.objectContaining({ type: "sync:failed", userId: user.id }));
  });

  it("completes the sync when the watch-history phase fails", async () => {
    const { server } = await newServer();
    setLibraries({ key: "1", title: "Movies", type: "movie" });
    fake.catalog["1"] = [movie("m1")];
    vi.mocked(syncWatchHistory).mockRejectedValueOnce(new Error("history down"));

    await syncMediaServer(server.id);

    expect(syncWatchHistory).toHaveBeenCalledWith(server.id, undefined, expect.any(AbortSignal), { reconcileAll: true });
    expect((await latestJob(server.id)).status).toBe("COMPLETED");
    expect(await prisma.mediaItem.count()).toBe(1);
  });

  it("still drops the media caches when recomputing canonical copies fails", async () => {
    const { server } = await newServer();
    setLibraries({ key: "1", title: "Movies", type: "movie" });
    fake.catalog["1"] = [movie("m1")];
    vi.mocked(recomputeCanonical).mockRejectedValueOnce(new Error("deadlock"));

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect((await latestJob(server.id)).status).toBe("COMPLETED");
    expect(invalidateMediaCaches).toHaveBeenCalledTimes(1);
  });
});

describe("status line and memory housekeeping", () => {
  it.each([
    [125_000, "Movies: 2m 5s"],
    [120_000, "Movies: 2m"],
  ])("formats a %ims library step in the status line", async (elapsed, expected) => {
    const { server } = await newServer();
    setLibraries({ key: "1", title: "Movies", type: "movie" });
    fake.catalog["1"] = Array.from({ length: 501 }, (_, i) => movie(`m${i}`));
    // The second page is fetched while the library's step is being timed.
    fake.onPage = (offset) => {
      if (offset !== 500) return;
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + elapsed);
    };
    let status: string | null = null;
    vi.mocked(syncWatchHistory).mockImplementationOnce(async () => {
      status = (await latestJob(server.id)).currentLibrary;
      return { count: 0 } as never;
    });

    await syncMediaServer(server.id);

    // The watch-history phase's status line lists every finished step first.
    expect(status).toBe(`${expected} · Syncing detailed watch history...`);
  });

  it("forces a collection when the runtime exposes gc", async () => {
    const { server } = await newServer();
    const gc = vi.fn();
    (globalThis as { gc?: unknown }).gc = gc;
    setLibraries();

    await syncMediaServer(server.id, undefined, { skipWatchHistory: true });

    expect(gc).toHaveBeenCalled();
    expect((await latestJob(server.id)).status).toBe("COMPLETED");
  });
});

describe("processBatch", () => {
  it("does nothing for an empty batch", async () => {
    await expect(processBatch([], "no-library", "MOVIE", new Map(), new Map())).resolves.toEqual({ dedupKeys: [] });
    expect(await prisma.mediaItem.count()).toBe(0);
  });
});
