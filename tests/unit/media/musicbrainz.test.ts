import { describe, it, expect } from "vitest";
import { mbidFromGuids, firstMbid, withArtistMbid, ARTIST_MBID_SCHEME } from "@/lib/media/musicbrainz";
import type { MediaMetadataItem } from "@/lib/media-server/types";

const A = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";
const B = "1a2b3c4d-1111-2222-3333-444455556666";

describe("musicbrainz helpers", () => {
  it("reads the first well-formed id from mbid:// or musicbrainz:// guids", () => {
    expect(mbidFromGuids([{ id: "plex://artist/abc" }, { id: `mbid://${A.toUpperCase()}` }])).toBe(A);
    expect(mbidFromGuids([{ id: `musicbrainz://${B}` }])).toBe(B);
    expect(mbidFromGuids([{ id: "mbid://not-an-id" }])).toBeNull();
    expect(mbidFromGuids(undefined)).toBeNull();
  });

  it("takes the first id from a multi-artist provider value", () => {
    expect(firstMbid(`${A}/${B}`)).toBe(A);
    expect(firstMbid("")).toBeNull();
    expect(firstMbid(undefined)).toBeNull();
  });

  it("adds the artist id as a musicbrainz:// guid, replacing an older one and keeping the rest", () => {
    const item = { ratingKey: "1", Guid: [{ id: `mbid://${B}` }, { id: `${ARTIST_MBID_SCHEME}://old` }] } as MediaMetadataItem;
    withArtistMbid(item, A);
    expect(item.Guid).toEqual([{ id: `mbid://${B}` }, { id: `musicbrainz://${A}` }]);
    const untouched = { ratingKey: "2", Guid: [{ id: `mbid://${B}` }] } as MediaMetadataItem;
    withArtistMbid(untouched, null);
    expect(untouched.Guid).toEqual([{ id: `mbid://${B}` }]);
  });
});
