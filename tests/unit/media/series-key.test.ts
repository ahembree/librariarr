import { describe, it, expect } from "vitest";
import {
  computeSeriesKey,
  resolveSeriesKey,
  seriesKeyFromTitle,
  normalizeSeriesTitle,
  seriesKeySqlExpression,
} from "@/lib/media/series-key";

describe("computeSeriesKey", () => {
  it("prefers the series-level TVDB id", () => {
    expect(
      computeSeriesKey({
        parentTitle: "The Office",
        externalIds: [
          { source: "TVDB", id: "73244" },
          { source: "TMDB", id: "2316" },
          { source: "IMDB", id: "tt0386676" },
        ],
      }),
    ).toBe("tvdb:73244");
  });

  it("falls back to TMDB when there is no TVDB id", () => {
    expect(
      computeSeriesKey({
        parentTitle: "The Office",
        externalIds: [{ source: "TMDB", id: "2316" }],
      }),
    ).toBe("tmdb:2316");
  });

  it("falls back to the normalized title when there is no external id", () => {
    expect(computeSeriesKey({ parentTitle: "The Office", externalIds: [] })).toBe(
      "title:the office",
    );
    expect(computeSeriesKey({ parentTitle: "  The   Wire  " })).toBe("title:the   wire");
  });

  it("matches source case-insensitively (the sync stores upper-case sources)", () => {
    expect(
      computeSeriesKey({ parentTitle: "X", externalIds: [{ source: "tvdb", id: "1" }] }),
    ).toBe("tvdb:1");
  });

  it("accepts the persisted MediaItemExternalId shape ({ source, externalId })", () => {
    expect(
      computeSeriesKey({
        parentTitle: "X",
        externalIds: [{ source: "TVDB", externalId: "999" }],
      }),
    ).toBe("tvdb:999");
  });

  it("ignores a blank id and falls through to the next source, then title", () => {
    expect(
      computeSeriesKey({
        parentTitle: "X",
        externalIds: [
          { source: "TVDB", id: "   " },
          { source: "TMDB", id: "42" },
        ],
      }),
    ).toBe("tmdb:42");
    expect(
      computeSeriesKey({
        parentTitle: "X",
        externalIds: [{ source: "TVDB", id: "" }],
      }),
    ).toBe("title:x");
  });

  it("separates two same-titled shows with different TVDB ids", () => {
    const uk = computeSeriesKey({
      parentTitle: "The Office",
      externalIds: [{ source: "TVDB", id: "78107" }],
    });
    const us = computeSeriesKey({
      parentTitle: "The Office",
      externalIds: [{ source: "TVDB", id: "73244" }],
    });
    expect(uk).not.toBe(us);
  });

  it("merges the same show across servers via a shared TVDB id", () => {
    const plex = computeSeriesKey({
      parentTitle: "Battlestar Galactica",
      externalIds: [{ source: "TVDB", id: "73545" }],
    });
    const jellyfin = computeSeriesKey({
      parentTitle: "battlestar galactica ", // different spelling/case on the other server
      externalIds: [{ source: "TVDB", id: "73545" }],
    });
    expect(plex).toBe(jellyfin);
  });

  it("returns null when there is neither a title nor an id", () => {
    expect(computeSeriesKey({ parentTitle: null })).toBeNull();
    expect(computeSeriesKey({ parentTitle: "   ", externalIds: [] })).toBeNull();
  });
});

describe("resolveSeriesKey", () => {
  it("uses the stored seriesKey column when present", () => {
    expect(
      resolveSeriesKey({ seriesKey: "tvdb:5", parentTitle: "Ignored", externalIds: [] }),
    ).toBe("tvdb:5");
  });

  it("recomputes from parentTitle + external ids when the column is absent", () => {
    expect(
      resolveSeriesKey({ parentTitle: "The Wire", externalIds: [{ source: "TVDB", id: "79126" }] }),
    ).toBe("tvdb:79126");
    expect(resolveSeriesKey({ seriesKey: null, parentTitle: "The Wire" })).toBe("title:the wire");
  });
});

describe("seriesKeyFromTitle / normalizeSeriesTitle", () => {
  it("normalizes case and surrounding whitespace only", () => {
    expect(normalizeSeriesTitle("  The Office  ")).toBe("the office");
    expect(seriesKeyFromTitle("The Office")).toBe("title:the office");
    expect(seriesKeyFromTitle("   ")).toBeNull();
  });
});

describe("seriesKeySqlExpression", () => {
  it("mirrors computeSeriesKey's precedence in its SQL text", () => {
    const sql = seriesKeySqlExpression("mi");
    // TVDB checked before TMDB before the title fallback.
    const tvdbAt = sql.indexOf("'tvdb:'");
    const tmdbAt = sql.indexOf("'tmdb:'");
    const titleAt = sql.indexOf("'title:'");
    expect(tvdbAt).toBeGreaterThanOrEqual(0);
    expect(tvdbAt).toBeLessThan(tmdbAt);
    expect(tmdbAt).toBeLessThan(titleAt);
    // Case-insensitive source match and blank-id guard, like the TS twin.
    expect(sql).toContain(`UPPER(e."source") = 'TVDB'`);
    expect(sql).toContain(`NULLIF(LOWER(TRIM(mi."parentTitle")), '')`);
  });

  it("honors the alias argument", () => {
    expect(seriesKeySqlExpression("x")).toContain(`x."parentTitle"`);
  });
});
