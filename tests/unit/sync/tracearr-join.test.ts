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
}

interface ExternalIdRow {
  mediaItemId: string;
  source: string;
  externalId: string;
}

/** Serve the two index queries by matching on their SQL. */
async function buildIndex(
  items: ItemRow[],
  externalIds: ExternalIdRow[] = [],
): Promise<TracearrJoinIndex> {
  mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM "MediaItemExternalId"')) return externalIds;
    if (sql.includes('FROM "MediaItem" mi')) return items;
    return [];
  });
  return buildTracearrJoinIndex("server-1");
}

function record(
  overrides: Partial<TracearrJoinRecord> = {},
): TracearrJoinRecord {
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
): ItemRow => ({
  id,
  ratingKey,
  type: "SERIES",
  seasonNumber,
  episodeNumber,
  grandparentRatingKey: null,
});

describe("buildTracearrJoinIndex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("indexes a server's items in a single query pass", async () => {
    const index = await buildIndex(
      [movie("item-1", "100"), movie("item-2", "200")],
      [{ mediaItemId: "item-1", source: "TMDB", externalId: "550" }],
    );

    expect(index.itemCount).toBe(2);
    expect(index.externalIdCount).toBe(1);
    // Two queries for the whole sync, not one per record: a first Tracearr
    // import is tens of thousands of records.
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it("ignores an external id whose media item is not on this server", async () => {
    const index = await buildIndex(
      [movie("item-1", "100")],
      [{ mediaItemId: "item-elsewhere", source: "TMDB", externalId: "550" }],
    );

    expect(
      resolveMediaItemId(index, record({ tmdb_id: 550 })),
    ).toEqual({ skipped: "unresolved" });
  });
});

describe("resolveMediaItemId — rating key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a record by its server-scoped rating key", async () => {
    const index = await buildIndex([movie("item-1", "100"), movie("item-2", "200")]);

    expect(resolveMediaItemId(index, record({ rating_key: "200" }))).toEqual({
      mediaItemId: "item-2",
    });
  });

  it("skips as ambiguous when two rows share a rating key", async () => {
    // Nothing enforces uniqueness on (library, ratingKey), so a collision is
    // possible — and there is no way to pick, so the play is dropped.
    const index = await buildIndex([movie("item-1", "100"), movie("item-2", "100")]);

    expect(resolveMediaItemId(index, record({ rating_key: "100" }))).toEqual({
      skipped: "ambiguous",
    });
  });

  it("falls through to the provider ids when the rating key is unknown", async () => {
    const index = await buildIndex(
      [movie("item-1", "100")],
      [{ mediaItemId: "item-1", source: "TVDB", externalId: "77" }],
    );

    // A stale rating key (the item was removed and re-added) must not cost the
    // play when the provider id still identifies it.
    expect(
      resolveMediaItemId(index, record({ rating_key: "999", tvdb_id: 77 })),
    ).toEqual({ mediaItemId: "item-1" });
  });
});

describe("resolveMediaItemId — provider fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The whole reason the episode constraint exists: the sync stores the
   * SERIES-level TVDB id on every episode row, so a bare id match returns the
   * show's entire episode list.
   */
  it("picks the right episode when every episode shares the show's TVDB id", async () => {
    const index = await buildIndex(
      [
        episode("ep-1", "1001", 1, 1),
        episode("ep-2", "1002", 1, 2),
        episode("ep-3", "1003", 2, 1),
      ],
      [
        { mediaItemId: "ep-1", source: "TVDB", externalId: "42" },
        { mediaItemId: "ep-2", source: "TVDB", externalId: "42" },
        { mediaItemId: "ep-3", source: "TVDB", externalId: "42" },
      ],
    );

    expect(
      resolveMediaItemId(
        index,
        record({
          media_type: "episode",
          tvdb_id: 42,
          season_number: 1,
          episode_number: 2,
        }),
      ),
    ).toEqual({ mediaItemId: "ep-2" });
  });

  it("treats season 0 as a real season number, not as absent", async () => {
    const index = await buildIndex(
      [episode("special-1", "900", 0, 1), episode("ep-1", "1001", 1, 1)],
      [
        { mediaItemId: "special-1", source: "TVDB", externalId: "42" },
        { mediaItemId: "ep-1", source: "TVDB", externalId: "42" },
      ],
    );

    expect(
      resolveMediaItemId(
        index,
        record({
          media_type: "episode",
          tvdb_id: 42,
          season_number: 0,
          episode_number: 1,
        }),
      ),
    ).toEqual({ mediaItemId: "special-1" });
  });

  it("skips an episode whose season number is unknown", async () => {
    const index = await buildIndex(
      [episode("ep-1", "1001", 1, 1), episode("ep-2", "1002", 1, 2)],
      [
        { mediaItemId: "ep-1", source: "TVDB", externalId: "42" },
        { mediaItemId: "ep-2", source: "TVDB", externalId: "42" },
      ],
    );

    // The show's id alone would match both rows; guessing one would attribute
    // the play to the wrong episode.
    expect(
      resolveMediaItemId(
        index,
        record({
          media_type: "episode",
          tvdb_id: 42,
          season_number: null,
          episode_number: 2,
        }),
      ),
    ).toEqual({ skipped: "ambiguous" });
  });

  it("skips an episode whose episode number is unknown", async () => {
    const index = await buildIndex(
      [episode("ep-1", "1001", 1, 1)],
      [{ mediaItemId: "ep-1", source: "TVDB", externalId: "42" }],
    );

    expect(
      resolveMediaItemId(
        index,
        record({
          media_type: "episode",
          tvdb_id: 42,
          season_number: 1,
          episode_number: null,
        }),
      ),
    ).toEqual({ skipped: "ambiguous" });
  });

  it("prefers TVDB over TMDB", async () => {
    const index = await buildIndex(
      [movie("item-tvdb", "100"), movie("item-tmdb", "200")],
      [
        { mediaItemId: "item-tvdb", source: "TVDB", externalId: "11" },
        { mediaItemId: "item-tmdb", source: "TMDB", externalId: "22" },
      ],
    );

    expect(
      resolveMediaItemId(index, record({ tvdb_id: 11, tmdb_id: 22 })),
    ).toEqual({ mediaItemId: "item-tvdb" });
  });

  it("falls back to TMDB when no row carries the TVDB id", async () => {
    const index = await buildIndex(
      [movie("item-tmdb", "200")],
      [{ mediaItemId: "item-tmdb", source: "TMDB", externalId: "22" }],
    );

    expect(
      resolveMediaItemId(index, record({ tvdb_id: 11, tmdb_id: 22 })),
    ).toEqual({ mediaItemId: "item-tmdb" });
  });

  it("falls back to IMDB last", async () => {
    const index = await buildIndex(
      [movie("item-imdb", "300")],
      [{ mediaItemId: "item-imdb", source: "IMDB", externalId: "tt0133093" }],
    );

    expect(
      resolveMediaItemId(
        index,
        record({ tvdb_id: 11, tmdb_id: 22, imdb_id: "tt0133093" }),
      ),
    ).toEqual({ mediaItemId: "item-imdb" });
  });

  it("matches the external-id source case-insensitively", async () => {
    // `MediaItemExternalId.source` is conventionally "TMDB" but nothing
    // enforces the casing — `series-key.ts` compares with UPPER() for the same
    // reason, and the index query normalizes the same way.
    const index = await buildIndex(
      [movie("item-1", "100")],
      [{ mediaItemId: "item-1", source: "tmdb", externalId: "550" }],
    );

    expect(resolveMediaItemId(index, record({ tmdb_id: 550 }))).toEqual({
      mediaItemId: "item-1",
    });
  });

  it("does not join a movie record to a series row sharing the id", async () => {
    const index = await buildIndex(
      [episode("ep-1", "1001", 1, 1)],
      [{ mediaItemId: "ep-1", source: "TVDB", externalId: "42" }],
    );

    expect(resolveMediaItemId(index, record({ tvdb_id: 42 }))).toEqual({
      skipped: "unresolved",
    });
  });

  it("does not join a track record to a movie row sharing the id", async () => {
    const index = await buildIndex(
      [movie("item-1", "100")],
      [{ mediaItemId: "item-1", source: "TMDB", externalId: "550" }],
    );

    expect(
      resolveMediaItemId(index, record({ media_type: "track", tmdb_id: 550 })),
    ).toEqual({ skipped: "unresolved" });
  });

  it("skips a record with no rating key and no provider ids", async () => {
    const index = await buildIndex([movie("item-1", "100")]);

    expect(resolveMediaItemId(index, record())).toEqual({
      skipped: "unresolved",
    });
  });

  it("skips as ambiguous when two rows share a provider id", async () => {
    const index = await buildIndex(
      [movie("item-1", "100"), movie("item-2", "200")],
      [
        { mediaItemId: "item-1", source: "TMDB", externalId: "550" },
        { mediaItemId: "item-2", source: "TMDB", externalId: "550" },
      ],
    );

    expect(resolveMediaItemId(index, record({ tmdb_id: 550 }))).toEqual({
      skipped: "ambiguous",
    });
  });
});

describe("resolveMediaItemId — unsupported types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["live", "photo", "trailer", "unknown"] as const)(
    "refuses a %s record before any lookup",
    async (mediaType) => {
      // None of these is a library item, so even an exact rating-key hit would
      // be a namespace collision rather than a match.
      const index = await buildIndex([movie("item-1", "100")]);

      expect(
        resolveMediaItemId(
          index,
          record({ media_type: mediaType, rating_key: "100" }),
        ),
      ).toEqual({ skipped: "unsupported-type" });
    },
  );

  describe("a rating key that now points somewhere else", () => {
    // Rating keys are the server's own ids, and Plex reuses them — they are
    // rowids, so a key that identified a deleted film can later identify a
    // different one. An un-corroborated hit files the old item's plays against
    // the new item under REAL usernames, which is the direction that ARMS a
    // positive `watchedByUser` DELETE (inflated play state only ever disarms).
    // Nothing revisits an upserted row, so it is permanent.
    it("skips a hit whose type disagrees with the record", async () => {
      const index = await buildIndex([episode("ep-1", "900", 1, 2)]);

      // Tracearr says this play was a movie; the key now belongs to an episode.
      expect(
        resolveMediaItemId(index, record({ media_type: "movie", rating_key: "900" })),
      ).toEqual({ skipped: "ambiguous" });
    });

    it("skips a hit whose TMDB id contradicts the record's", async () => {
      const index = await buildIndex(
        [movie("movie-new", "900")],
        [{ mediaItemId: "movie-new", source: "TMDB", externalId: "111" }],
      );

      expect(
        resolveMediaItemId(
          index,
          record({ media_type: "movie", rating_key: "900", tmdb_id: 222 }),
        ),
      ).toEqual({ skipped: "ambiguous" });
    });

    it("does not contradict on TVDB, which the two catalogues disagree about", async () => {
      // Observed on a live instance for films that are unambiguously the same:
      // "Batman: The Dark Knight Returns, Part 2" is tvdb 2113 in the library
      // and 292129 in Tracearr; "Demon Slayer: Infinity Castle" is 357928 vs
      // 357931. TVDB carries more than one namespace and the two systems
      // populate it from different ones, so a mismatch there proves nothing —
      // only TMDB and IMDB are worth contradicting on.
      const index = await buildIndex(
        [movie("movie-1", "900")],
        [{ mediaItemId: "movie-1", source: "TVDB", externalId: "2113" }],
      );

      expect(
        resolveMediaItemId(
          index,
          record({ media_type: "movie", rating_key: "900", tvdb_id: 292129 }),
        ),
      ).toEqual({ mediaItemId: "movie-1" });
    });

    it("still resolves when the ids agree", async () => {
      const index = await buildIndex(
        [movie("movie-1", "900")],
        [{ mediaItemId: "movie-1", source: "TMDB", externalId: "111" }],
      );

      expect(
        resolveMediaItemId(
          index,
          record({ media_type: "movie", rating_key: "900", tmdb_id: 111 }),
        ),
      ).toEqual({ mediaItemId: "movie-1" });
    });

    it("accepts silence on either side rather than treating it as disagreement", async () => {
      // Provider ids are far from universally populated; refusing on absence
      // would drop most legitimate plays to catch a rare reuse.
      const bare = await buildIndex([movie("movie-1", "900")]);
      expect(
        resolveMediaItemId(
          bare,
          record({ media_type: "movie", rating_key: "900", tmdb_id: 222 }),
        ),
      ).toEqual({ mediaItemId: "movie-1" });

      const withId = await buildIndex(
        [movie("movie-1", "900")],
        [{ mediaItemId: "movie-1", source: "TMDB", externalId: "111" }],
      );
      // The record carries an IMDB id the item has nothing to compare against.
      expect(
        resolveMediaItemId(
          withId,
          record({ media_type: "movie", rating_key: "900", imdb_id: "tt999" }),
        ),
      ).toEqual({ mediaItemId: "movie-1" });
    });
  });


  describe("episodes are corroborated on the show, not on provider ids", () => {
    // The granularity trap, found in production. Tracearr sends the EPISODE's
    // tvdb/tmdb/imdb — a different value per episode — while Librariarr stores
    // the SERIES-level ids on every episode row. Comparing them finds a
    // mismatch for every episode of every show whose records carry ids, which
    // is most of them: measured against a live instance this rejected all 138
    // episodes of one show whose plays Tracearr held under our own rating keys,
    // while shows whose records happened to carry no ids imported fine.
    it("resolves an episode whose record carries episode-level provider ids", async () => {
      const index = await buildIndex(
        [{ ...episode("ep-1", "157667", 1, 1), grandparentRatingKey: "58337" }],
        // Series-level ids, as the sync stores them on every episode.
        [{ mediaItemId: "ep-1", source: "TVDB", externalId: "248741" }],
      );

      expect(
        resolveMediaItemId(
          index,
          record({
            media_type: "episode",
            rating_key: "157667",
            grandparent_rating_key: "58337",
            season_number: 1,
            episode_number: 1,
            tvdb_id: 4099506, // the EPISODE's id — not comparable to ours
          }),
        ),
      ).toEqual({ mediaItemId: "ep-1" });
    });

    it("still skips an episode whose rating key now belongs to a different show", async () => {
      // The reuse hazard the corroboration exists for, checked on the one id
      // that IS comparable: the show's own rating key on the same server.
      const index = await buildIndex([
        { ...episode("ep-1", "157667", 1, 1), grandparentRatingKey: "99999" },
      ]);

      expect(
        resolveMediaItemId(
          index,
          record({
            media_type: "episode",
            rating_key: "157667",
            grandparent_rating_key: "58337",
            season_number: 1,
            episode_number: 1,
          }),
        ),
      ).toEqual({ skipped: "ambiguous" });
    });

    it("accepts when either side has no show rating key", async () => {
      const index = await buildIndex([
        { ...episode("ep-1", "157667", 1, 1), grandparentRatingKey: null },
      ]);

      expect(
        resolveMediaItemId(
          index,
          record({
            media_type: "episode",
            rating_key: "157667",
            grandparent_rating_key: "58337",
            season_number: 1,
            episode_number: 1,
          }),
        ),
      ).toEqual({ mediaItemId: "ep-1" });
    });
  });

});
