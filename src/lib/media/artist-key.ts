/**
 * Artist identity for music — client-safe (imports only `series-key.ts`).
 *
 * Tracks carry their artist only as `parentTitle`, so two different artists
 * who share a name ("Nirvana" the 1960s UK band and the Seattle one, "Bush",
 * "Low") grouped as ONE artist everywhere tracks were folded by title: one
 * aggregate for the rule engine (play counts, last played, size and watched-by
 * blended across both), one group for the whole-artist exception guard (an
 * exception on one blocked deletes of the other, and an exception on the other
 * was all that protected it).
 *
 * Every track already stores its ARTIST's MusicBrainz id as `MUSICBRAINZ`
 * (Jellyfin/Emby from `MusicBrainzAlbumArtist ?? MusicBrainzArtist`, Plex
 * through `writeArtistMbids`), and that is the id every Lidarr action resolves
 * the artist by. It is what tells two same-named artists apart.
 *
 * It is NOT used as a key on its own, and a title is split by it only when
 * that cannot leave part of an artist out. Coverage can be partial — on
 * Jellyfin the id comes per album, so one untagged album leaves some of an
 * artist's tracks without it — and an untagged track cannot be placed under
 * either id. Grouped apart from its artist, it takes its plays with it: a
 * "not played in N months" rule matching the rest arms a DELETE_LIDARR that
 * removes the whole artist, the album played every week included. So a title
 * group is split ONLY when it carries two or more different ids AND every
 * track carries one. Anything else keeps the title whole, as it always was.
 *
 * One artist can still carry two ids (an id MusicBrainz has since merged, or
 * Jellyfin falling back to a track artist's id), and that is invisible here.
 * Lidarr resolves a merged id to its artist, so the whole-artist delete checks
 * the other ids under the title before acting (`refuseSplitArtistDelete` in
 * `lifecycle/actions.ts`).
 */

import { normalizeSeriesTitle } from "./series-key";

export interface ArtistExternalIdLike {
  source: string;
  externalId: string;
}

const ARTIST_MBID_SOURCE = "MUSICBRAINZ";

/** The track's artist MusicBrainz id, or null when it has none. */
export function artistMbidOf(
  externalIds: ReadonlyArray<ArtistExternalIdLike> | null | undefined,
): string | null {
  for (const e of externalIds ?? []) {
    if (e.source.toUpperCase() !== ARTIST_MBID_SOURCE) continue;
    const value = e.externalId.trim();
    if (value) return value;
  }
  return null;
}

/**
 * `LOWER(TRIM(title))` — the normalization artist titles are compared by,
 * everywhere one is (the exception guard, query action batching and
 * collapsing). The same function as `normalizeSeriesTitle`, which the music
 * library listings' SQL `LOWER(TRIM("parentTitle"))` also matches.
 */
export const normalizeArtistTitle = normalizeSeriesTitle;

/**
 * Splits one artist-title group by MusicBrainz id when — and only when — it
 * holds two or more different ids and every track carries one: each id
 * becomes its own group. Otherwise the group is returned whole, exactly as it
 * grouped before (see the header for why an untagged track never splits).
 *
 * Groups come back in first-seen order; tracks keep their order within each.
 */
export function splitArtistGroupByMbid<T>(
  tracks: T[],
  mbidOf: (track: T) => string | null,
): T[][] {
  const byMbid = new Map<string, T[]>();
  for (const track of tracks) {
    const mbid = mbidOf(track);
    if (!mbid) return [tracks];
    const group = byMbid.get(mbid);
    if (group) group.push(track);
    else byMbid.set(mbid, [track]);
  }
  if (byMbid.size <= 1) return [tracks];
  return [...byMbid.values()];
}
