import { describe, it, expect } from "vitest";
import { artistMbidOf, normalizeArtistTitle, splitArtistGroupByMbid } from "@/lib/media/artist-key";

interface Track {
  id: string;
  mbid: string | null;
}
const t = (id: string, mbid: string | null = null): Track => ({ id, mbid });
const ids = (groups: Track[][]) => groups.map((g) => g.map((x) => x.id));

describe("splitArtistGroupByMbid", () => {
  it("keeps a title with one artist id together, tracks without the id included", () => {
    // Partial coverage (an untagged album on Jellyfin) must not split one
    // artist into a partial second "artist" whose aggregates read half its plays.
    const groups = splitArtistGroupByMbid([t("1", "A"), t("2"), t("3", "A")], (x) => x.mbid);
    expect(ids(groups)).toEqual([["1", "2", "3"]]);
  });

  it("keeps a title with no ids at all together", () => {
    expect(ids(splitArtistGroupByMbid([t("1"), t("2")], (x) => x.mbid))).toEqual([["1", "2"]]);
  });

  it("splits a title carrying two artist ids, with the id-less tracks on their own", () => {
    const groups = splitArtistGroupByMbid(
      [t("1", "A"), t("2", "B"), t("3"), t("4", "A")],
      (x) => x.mbid,
    );
    expect(ids(groups)).toEqual([["1", "4"], ["2"], ["3"]]);
  });

  it("returns no id-less group when every track has an id", () => {
    expect(ids(splitArtistGroupByMbid([t("1", "A"), t("2", "B")], (x) => x.mbid))).toEqual([["1"], ["2"]]);
  });
});

describe("artistMbidOf", () => {
  it("reads the MUSICBRAINZ id, case-insensitively and trimmed", () => {
    expect(artistMbidOf([{ source: "TMDB", externalId: "1" }, { source: "musicbrainz", externalId: " m " }])).toBe("m");
  });

  it("is null when absent or blank", () => {
    expect(artistMbidOf(undefined)).toBeNull();
    expect(artistMbidOf([{ source: "MUSICBRAINZ", externalId: "  " }])).toBeNull();
    // The track's own id is not its artist's.
    expect(artistMbidOf([{ source: "MBID", externalId: "track" }])).toBeNull();
  });
});

describe("normalizeArtistTitle", () => {
  it("trims and lower-cases", () => {
    expect(normalizeArtistTitle("  Nirvana ")).toBe("nirvana");
  });
});
