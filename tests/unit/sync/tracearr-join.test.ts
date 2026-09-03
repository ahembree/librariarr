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
});

const episode = (
  id: string,
  ratingKey: string,
  seasonNumber: number,
  episodeNumber: number,
): ItemRow => ({ id, ratingKey, type: "SERIES", seasonNumber, episodeNumber });

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
});
