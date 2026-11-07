import { describe, it, expect } from "vitest";
import {
  ARTIST_KEY_SQL,
  albumArtistKeySql,
  albumTitleDisplay,
  albumTitleDisplaySql,
  albumTitleKey,
  albumTitleKeySql,
  audioCodecLabelSql,
  foldCodecCounts,
} from "@/lib/media/music-sql";

describe("music SQL fragments", () => {
  it("keys artists the way the presence map does", () => {
    expect(ARTIST_KEY_SQL).toBe(`LOWER(TRIM(mi."parentTitle"))`);
  });

  it("labels a missing or blank codec Unknown and upper-cases the rest", () => {
    expect(audioCodecLabelSql(`mi."audioCodec"`)).toBe(`COALESCE(UPPER(NULLIF(mi."audioCodec", '')), 'Unknown')`);
  });
});

describe("album keys", () => {
  it("groups an album by its title lower-cased and trimmed, a missing or blank one as Unknown Album", () => {
    expect(albumTitleKeySql(`mi."albumTitle"`)).toBe(`LOWER(COALESCE(NULLIF(TRIM(mi."albumTitle"), ''), 'Unknown Album'))`);
    expect(albumTitleDisplaySql(`mi."albumTitle"`)).toBe(
      `CASE WHEN NULLIF(TRIM(mi."albumTitle"), '') IS NULL THEN 'Unknown Album' ELSE mi."albumTitle" END`,
    );
    expect(albumArtistKeySql(`mi."parentTitle"`)).toBe(`LOWER(TRIM(COALESCE(mi."parentTitle", 'Unknown Artist')))`);
  });

  it("keys an album in JS as the SQL does", () => {
    expect(albumTitleKey("  Abbey Road ")).toBe("abbey road");
    expect(albumTitleKey(null)).toBe("unknown album");
    expect(albumTitleKey("")).toBe("unknown album");
    expect(albumTitleKey("   ")).toBe("unknown album");
    expect(albumTitleKey("Unknown Album")).toBe(albumTitleKey(null));
    // SQL TRIM strips spaces only.
    expect(albumTitleKey("Album\t")).toBe("album\t");
    expect(albumTitleKey("\nAlbum")).toBe("\nalbum");
  });

  it("titles an album group by the track's spelling, or Unknown Album", () => {
    expect(albumTitleDisplay(" Abbey Road")).toBe(" Abbey Road");
    expect(albumTitleDisplay(null)).toBe("Unknown Album");
    expect(albumTitleDisplay("  ")).toBe("Unknown Album");
  });
});

describe("foldCodecCounts", () => {
  it("groups codec counts by group key", () => {
    const folded = foldCodecCounts([
      { group_key: "queen", codec: "FLAC", n: 3 },
      { group_key: "queen", codec: "MP3", n: 1 },
      { group_key: "abba", codec: "Unknown", n: 2 },
    ]);
    expect(Object.fromEntries(folded)).toEqual({
      queen: { FLAC: 3, MP3: 1 },
      abba: { Unknown: 2 },
    });
  });

  it("adds up a codec that appears twice for one group", () => {
    const folded = foldCodecCounts([
      { group_key: "queen", codec: "FLAC", n: 3 },
      { group_key: "queen", codec: "FLAC", n: 2 },
    ]);
    expect(folded.get("queen")).toEqual({ FLAC: 5 });
  });

  it("is empty for no rows", () => {
    expect(foldCodecCounts([]).size).toBe(0);
  });
});
