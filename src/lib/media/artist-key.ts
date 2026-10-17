/**
 * Artist identity for music — client-safe, no imports.
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
 * It is NOT used as a key on its own. Coverage can be partial — on Jellyfin
 * the id comes per album, so one untagged album leaves some of an artist's
 * tracks without it — and keyed on the id, those tracks would form a second,
 * partial "artist" whose aggregates read only half the artist's plays: a
 * "not played in N months" rule matching that half arms a DELETE_LIDARR that
 * removes the whole artist. So a title group is split by id ONLY when it
 * carries two or more different ids, which is the one case where the title
 * provably names more than one artist.
 */

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

/** `LOWER(TRIM(title))` — the normalization artist titles are compared by. */
export function normalizeArtistTitle(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * Splits one artist-title group by MusicBrainz id when — and only when — it
 * holds two or more different ids. Each id becomes its own group, and the
 * tracks with no id form one more group (they cannot be placed under either
 * artist; such a group's representative has no id, so a Lidarr action on it
 * cannot resolve an artist and fails rather than guessing). A group with at
 * most one distinct id is returned unchanged, exactly as it grouped before.
 *
 * Groups come back in first-seen order; tracks keep their order within each.
 */
export function splitArtistGroupByMbid<T>(
  tracks: T[],
  mbidOf: (track: T) => string | null,
): T[][] {
  const byMbid = new Map<string, T[]>();
  const withoutMbid: T[] = [];
  for (const track of tracks) {
    const mbid = mbidOf(track);
    if (!mbid) {
      withoutMbid.push(track);
      continue;
    }
    const group = byMbid.get(mbid);
    if (group) group.push(track);
    else byMbid.set(mbid, [track]);
  }
  if (byMbid.size <= 1) return [tracks];
  const groups = [...byMbid.values()];
  if (withoutMbid.length > 0) groups.push(withoutMbid);
  return groups;
}
