import type { MediaMetadataItem } from "@/lib/media-server/types";

/**
 * Music items carry the ARTIST's MusicBrainz id as the `MUSICBRAINZ` external
 * id — the id Lidarr keys artists by (`foreignArtistId`), and the source every
 * Lidarr consumer reads (`arrIdSourceFor`, the rule engines, the action
 * executors, arr-info). Nothing used to write it: Plex `mbid://` guids were
 * stored under `MBID`, and on a track that guid is the track's own id, not the
 * artist's, while Jellyfin/Emby provider ids were not mapped for music at all.
 * Every Lidarr action then failed with "No MusicBrainz ID found", and every
 * music item read as not in Lidarr.
 *
 * The track keeps its own id under `MBID`; the artist's is added as a
 * `musicbrainz://` guid, which the sync's guid parser stores as `MUSICBRAINZ`.
 */
export const ARTIST_MBID_SCHEME = "musicbrainz";

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The first MusicBrainz id in a list of guids (`mbid://…` or `musicbrainz://…`). */
export function mbidFromGuids(guids: Array<{ id: string }> | undefined): string | null {
  for (const guid of guids ?? []) {
    const match = guid.id.match(/^(mbid|musicbrainz):\/\/(.+)$/i);
    if (match && MBID.test(match[2])) return match[2].toLowerCase();
  }
  return null;
}

/** The first well-formed MusicBrainz id in a provider-id value ("id" or "id1/id2"). */
export function firstMbid(value: string | undefined | null): string | null {
  for (const part of (value ?? "").split(/[/;,\s]+/)) {
    if (MBID.test(part)) return part.toLowerCase();
  }
  return null;
}

/** Adds the artist's MusicBrainz id to a track's guids, replacing any earlier one. */
export function withArtistMbid(item: MediaMetadataItem, artistMbid: string | null): MediaMetadataItem {
  if (!artistMbid) return item;
  const guids = (item.Guid ?? []).filter((g) => !g.id.toLowerCase().startsWith(`${ARTIST_MBID_SCHEME}://`));
  item.Guid = [...guids, { id: `${ARTIST_MBID_SCHEME}://${artistMbid}` }];
  return item;
}
