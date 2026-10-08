import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { $queryRawUnsafe: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildTracearrJoinIndex,
  resolveMediaItemId,
  type TracearrJoinIndex,
  type TracearrJoinRecord,
} from "@/lib/sync/tracearr-join";

interface ItemRow {
  id: string;
  ratingKey: string;
  type: "MOVIE" | "SERIES" | "MUSIC";
  seasonNumber: number | null;
  episodeNumber: number | null;
  /** The show's rating key — an episode's only same-granularity identifier. */
  grandparentRatingKey?: string | null;
  /** Which of the server's libraries lists it. */
  libraryId?: string;
  /** The media server's type, as the index query returns it on every row. */
  serverType?: string;
}

/** `[mediaItemId, source, externalId]` */
type ExternalIdRow = [string, string, string];

/** Serve the two index queries by matching on their SQL. */
async function buildIndex(items: ItemRow[], externalIds: ExternalIdRow[] = []): Promise<TracearrJoinIndex> {
  mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM "MediaItemExternalId"')) {
      return externalIds.map(([mediaItemId, source, externalId]) => ({ mediaItemId, source, externalId }));
    }
    if (sql.includes('FROM "MediaItem" mi')) return items;
    return [];
  });
  return buildTracearrJoinIndex("server-1");
}

function record(overrides: Partial<TracearrJoinRecord> = {}): TracearrJoinRecord {
  return {
    media_type: "movie",
    rating_key: null,
    grandparent_rating_key: null,
    season_number: null,
    episode_number: null,
    tvdb_id: null,
    tmdb_id: null,
    imdb_id: null,
    ...overrides,
  };
}

/** Index `items` and `externalIds`, then resolve one record. */
async function resolve(items: ItemRow[], externalIds: ExternalIdRow[], overrides: Partial<TracearrJoinRecord>) {
  return resolveMediaItemId(await buildIndex(items, externalIds), record(overrides));
}

const movie = (id: string, ratingKey: string): ItemRow => ({
  id,
  ratingKey,
  type: "MOVIE",
  seasonNumber: null,
  episodeNumber: null,
  grandparentRatingKey: null,
});

const episode = (
  id: string,
  ratingKey: string,
  seasonNumber: number,
  episodeNumber: number,
  show: string | null = null,
): ItemRow => ({
  id,
  ratingKey,
  type: "SERIES",
  seasonNumber,
  episodeNumber,
  grandparentRatingKey: show,
});

const episodeRecord = (ratingKey: string, show: string, extra: Partial<TracearrJoinRecord> = {}) => ({
  media_type: "episode" as const,
  rating_key: ratingKey,
  grandparent_rating_key: show,
  season_number: 1,
  episode_number: 1,
  ...extra,
});

const UNRESOLVED = { skipped: "unresolved" };
const AMBIGUOUS = { skipped: "ambiguous" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildTracearrJoinIndex", () => {
  it("indexes a server's items in a single query pass", async () => {
    const index = await buildIndex([movie("item-1", "100"), movie("item-2", "200")], [["item-1", "TMDB", "550"]]);

    expect(index.itemCount).toBe(2);
    expect(index.externalIdCount).toBe(1);
    // Two queries for the whole sync, not one per record: a first import is tens of thousands.
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it("ignores an external id whose media item is not on this server", async () => {
    expect(await resolve([movie("item-1", "100")], [["item-elsewhere", "TMDB", "550"]], { tmdb_id: 550 })).toEqual(UNRESOLVED);
  });
});

describe("resolveMediaItemId", () => {
  type Case = [string, ItemRow[], ExternalIdRow[], Partial<TracearrJoinRecord>, object];

  it.each<Case>([
    // ── rating key
    [
      "resolves a record by its server-scoped rating key",
      [movie("item-1", "100"), movie("item-2", "200")], [], { rating_key: "200" }, { mediaItemId: "item-2" },
    ],
    // Unique only within a library; outside the library-copy case there is no way to pick.
    [
      "skips as ambiguous when two rows share a rating key",
      [movie("item-1", "100"), movie("item-2", "100")], [], { rating_key: "100" }, AMBIGUOUS,
    ],
    // A stale rating key (removed and re-added) must not cost a play the provider id still identifies.
    [
      "falls through to the provider ids when the rating key is unknown",
      [movie("item-1", "100")], [["item-1", "TMDB", "77"]], { rating_key: "999", tmdb_id: 77 }, { mediaItemId: "item-1" },
    ],

    // ── provider fallback
    // Tracearr sends an episode's OWN ids, every episode row the SERIES-level
    // ones: they only meet by numeric coincidence — a different show.
    [
      "never resolves an episode by provider id",
      [episode("other-show-s1e1", "2001", 1, 1, "77")],
      [["other-show-s1e1", "TVDB", "305288"], ["other-show-s1e1", "TMDB", "66732"]],
      episodeRecord("deleted-key", "12", { tvdb_id: 305288, tmdb_id: 66732 }),
      UNRESOLVED,
    ],
    [
      "never resolves a film by TVDB, which the two catalogues disagree about",
      [movie("other-film", "100")], [["other-film", "TVDB", "2113"]], { rating_key: "555", tvdb_id: 2113 }, UNRESOLVED,
    ],
    // Corroborated like a rating-key hit: another IMDB id means another work sharing the TMDB id.
    [
      "refuses a provider-id hit whose other id contradicts the record",
      [movie("item-1", "100")], [["item-1", "TMDB", "22"], ["item-1", "IMDB", "tt0000001"]],
      { tmdb_id: 22, imdb_id: "tt0133093" }, AMBIGUOUS,
    ],
    [
      "prefers TMDB over IMDB",
      [movie("item-tmdb", "100"), movie("item-imdb", "200")], [["item-tmdb", "TMDB", "22"], ["item-imdb", "IMDB", "tt0133093"]],
      { tmdb_id: 22, imdb_id: "tt0133093" }, { mediaItemId: "item-tmdb" },
    ],
    [
      "falls back to TMDB when no row carries the TVDB id",
      [movie("item-tmdb", "200")], [["item-tmdb", "TMDB", "22"]], { tvdb_id: 11, tmdb_id: 22 }, { mediaItemId: "item-tmdb" },
    ],
    [
      "falls back to IMDB last",
      [movie("item-imdb", "300")], [["item-imdb", "IMDB", "tt0133093"]],
      { tvdb_id: 11, tmdb_id: 22, imdb_id: "tt0133093" }, { mediaItemId: "item-imdb" },
    ],
    // Nothing enforces the casing; the index query normalizes like `series-key.ts`.
    [
      "matches the external-id source case-insensitively",
      [movie("item-1", "100")], [["item-1", "tmdb", "550"]], { tmdb_id: 550 }, { mediaItemId: "item-1" },
    ],
    // TMDB movie and TV ids share one numeric space.
    [
      "does not join a movie record to a series row sharing the id",
      [episode("ep-1", "1001", 1, 1)], [["ep-1", "TMDB", "42"]], { tmdb_id: 42 }, UNRESOLVED,
    ],
    [
      "does not join a track record to a movie row sharing the id",
      [movie("item-1", "100")], [["item-1", "TMDB", "550"]], { media_type: "track", tmdb_id: 550 }, UNRESOLVED,
    ],
    ["skips a record with no rating key and no provider ids", [movie("item-1", "100")], [], {}, UNRESOLVED],
    [
      "skips as ambiguous when two rows share a provider id",
      [movie("item-1", "100"), movie("item-2", "200")], [["item-1", "TMDB", "550"], ["item-2", "TMDB", "550"]],
      { tmdb_id: 550 }, AMBIGUOUS,
    ],
  ])("%s", async (_name, items, externalIds, overrides, expected) => {
    expect(await resolve(items, externalIds, overrides)).toEqual(expected);
  });

  // None of these is a library item: even an exact rating-key hit is a namespace collision.
  it.each(["live", "photo", "trailer", "unknown"] as const)("refuses a %s record before any lookup", async (mediaType) => {
    expect(await resolve([movie("item-1", "100")], [], { media_type: mediaType, rating_key: "100" })).toEqual({
      skipped: "unsupported-type",
    });
  });

  // Plex reuses rating keys (they are rowids), so a key that named a deleted
  // film can later name a different one: an un-corroborated hit files the old
  // item's plays under REAL usernames — the direction that ARMS a positive
  // `watchedByUser` DELETE — and nothing revisits an upserted row.
  it.each<Case>([
    ["skips a hit whose type disagrees with the record", [episode("ep-1", "900", 1, 2)], [], { rating_key: "900" }, AMBIGUOUS],
    [
      "skips a hit whose TMDB id contradicts the record's",
      [movie("movie-new", "900")], [["movie-new", "TMDB", "111"]], { rating_key: "900", tmdb_id: 222 }, AMBIGUOUS,
    ],
    // The same film is tvdb 2113 in the library and 292129 in Tracearr: a TVDB mismatch proves nothing.
    [
      "does not contradict on TVDB",
      [movie("movie-1", "900")], [["movie-1", "TVDB", "2113"]], { rating_key: "900", tvdb_id: 292129 }, { mediaItemId: "movie-1" },
    ],
    [
      "still resolves when the ids agree",
      [movie("movie-1", "900")], [["movie-1", "TMDB", "111"]], { rating_key: "900", tmdb_id: 111 }, { mediaItemId: "movie-1" },
    ],
    // Provider ids are far from universal: refusing on absence would drop most plays.
    [
      "accepts silence on the item's side",
      [movie("movie-1", "900")], [], { rating_key: "900", tmdb_id: 222 }, { mediaItemId: "movie-1" },
    ],
    [
      "accepts silence on the record's side",
      [movie("movie-1", "900")], [["movie-1", "TMDB", "111"]], { rating_key: "900", imdb_id: "tt999" }, { mediaItemId: "movie-1" },
    ],
    // Episodes are corroborated on the show's rating key: Tracearr's provider
    // ids are the EPISODE's, ours the SERIES', and comparing them rejected
    // every episode of every show whose records carry ids.
    [
      "resolves an episode whose record carries episode-level provider ids",
      [episode("ep-1", "157667", 1, 1, "58337")], [["ep-1", "TVDB", "248741"]],
      episodeRecord("157667", "58337", { tvdb_id: 4099506 }), { mediaItemId: "ep-1" },
    ],
    [
      "skips an episode whose rating key now belongs to a different show",
      [episode("ep-1", "157667", 1, 1, "99999")], [], episodeRecord("157667", "58337"), AMBIGUOUS,
    ],
    [
      "accepts an episode when either side has no show rating key",
      [episode("ep-1", "157667", 1, 1)], [], episodeRecord("157667", "58337"), { mediaItemId: "ep-1" },
    ],
  ])("a rating key that may now point somewhere else: %s", async (_name, items, externalIds, overrides, expected) => {
    expect(await resolve(items, externalIds, overrides)).toEqual(expected);
  });
});

describe("resolveMediaItemId — library copies of one Jellyfin/Emby item", () => {
  // Two libraries over one folder list the same item under the same id: a play of it is a play of both.
  const on = (serverType: string, libraryId: string, row: ItemRow): ItemRow => ({ ...row, libraryId, serverType });
  const jellyfin = (libraryId: string, row: ItemRow) => on("JELLYFIN", libraryId, row);
  const episodeOfShow1 = { media_type: "episode" as const, rating_key: "jf-ep", grandparent_rating_key: "show-1" };

  it.each(["JELLYFIN", "EMBY"])("files a %s play against every copy, the lowest id first", async (type) => {
    const items = ["c", "a", "b"].map((x) => on(type, `lib-${x}`, movie(`item-${x}`, "jf-1")));

    expect(await resolve(items, [], { rating_key: "jf-1" })).toEqual({ mediaItemId: "item-a", copies: ["item-b", "item-c"] });
  });

  it("files an episode's play against every copy whose show matches", async () => {
    const items = [jellyfin("lib-a", episode("ep-a", "jf-ep", 1, 1, "show-1")), jellyfin("lib-b", episode("ep-b", "jf-ep", 1, 1, "show-1"))];

    expect(await resolve(items, [], episodeOfShow1)).toEqual({ mediaItemId: "ep-a", copies: ["ep-b"] });
  });

  it.each<[string, ItemRow[], ExternalIdRow[], Partial<TracearrJoinRecord>]>([
    [
      "the same rating key in two Plex libraries — a stale row there, not a copy",
      [on("PLEX", "lib-a", movie("item-a", "100")), on("PLEX", "lib-b", movie("item-b", "100"))], [], { rating_key: "100" },
    ],
    [
      "two hits in one library — one library cannot list an item twice",
      [jellyfin("lib-a", movie("item-a", "jf-1")), jellyfin("lib-a", movie("item-b", "jf-1"))], [], { rating_key: "jf-1" },
    ],
    [
      "a copy that is not the type the record names",
      [jellyfin("lib-a", movie("item-a", "jf-1")), jellyfin("lib-b", episode("item-b", "jf-1", 1, 1))], [], { rating_key: "jf-1" },
    ],
    [
      "a copy that contradicts the record's identity",
      [jellyfin("lib-a", movie("item-a", "jf-1")), jellyfin("lib-b", movie("item-b", "jf-1"))],
      [["item-a", "TMDB", "550"], ["item-b", "TMDB", "999"]],
      { rating_key: "jf-1", tmdb_id: 550 },
    ],
    [
      "a copy of an episode that belongs to another show",
      [on("EMBY", "lib-a", episode("ep-a", "jf-ep", 1, 1, "show-1")), on("EMBY", "lib-b", episode("ep-b", "jf-ep", 1, 1, "show-2"))],
      [],
      episodeOfShow1,
    ],
    // Two rows sharing a TMDB id are two files (a 4K beside a 1080p), never a fan-out.
    [
      "a provider-id hit on two rows",
      [jellyfin("lib-a", movie("item-uhd", "jf-4k")), jellyfin("lib-b", movie("item-hd", "jf-hd"))],
      [["item-uhd", "TMDB", "603"], ["item-hd", "TMDB", "603"]],
      { rating_key: "gone", tmdb_id: 603 },
    ],
  ])("skips %s", async (_name, items, externalIds, overrides) => {
    expect(await resolve(items, externalIds, overrides)).toEqual(AMBIGUOUS);
  });
});
