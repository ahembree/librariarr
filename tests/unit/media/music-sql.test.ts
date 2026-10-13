import { describe, it, expect } from "vitest";
import { ARTIST_KEY_SQL, audioCodecLabelSql, foldCodecCounts } from "@/lib/media/music-sql";

describe("music SQL fragments", () => {
  it("keys artists the way the presence map does", () => {
    expect(ARTIST_KEY_SQL).toBe(`LOWER(TRIM(mi."parentTitle"))`);
  });

  it("labels a missing or blank codec Unknown and upper-cases the rest", () => {
    expect(audioCodecLabelSql(`mi."audioCodec"`)).toBe(`COALESCE(UPPER(NULLIF(mi."audioCodec", '')), 'Unknown')`);
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
