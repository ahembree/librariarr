import type { MediaServerType } from "@/generated/prisma/client";

/**
 * The only paths `/api/tools/sessions/image` fetches: the artwork a playback
 * session names (`thumb`, `parentThumb`, `grandparentThumb`), in the shapes
 * the clients produce — Plex `/library/metadata/<ratingKey>/<kind>[/<ts>]`,
 * Jellyfin/Emby `/Items/<id>/Images/<type>[/<index>]`.
 *
 * The request carries the server's stored admin token and its body goes back
 * to the browser, so any path the server serves would otherwise be readable
 * by any session cookie, stale or not — and Plex's `/myplex/account` answers
 * with the owner's plex.tv token, which signs in to Librariarr
 * (`POST /api/auth/plex/token`) with a fresh `authenticatedAt`. An anchored
 * allow-list with no free-form segment also rules out `..` and query strings.
 */
const PLEX_ARTWORK_PATH = /^\/library\/metadata\/\d+\/(?:thumb|art|banner|clearLogo)(?:\/\d+)?$/;
const JELLYFIN_ARTWORK_PATH =
  /^\/Items\/[A-Za-z0-9-]+\/Images\/(?:Primary|Backdrop|Thumb|Logo|Banner|Art|Disc)(?:\/\d+)?$/;

export function isSessionArtworkPath(type: MediaServerType, path: string): boolean {
  switch (type) {
    case "PLEX":
      return PLEX_ARTWORK_PATH.test(path);
    case "JELLYFIN":
    case "EMBY":
      return JELLYFIN_ARTWORK_PATH.test(path);
    default:
      return false;
  }
}
