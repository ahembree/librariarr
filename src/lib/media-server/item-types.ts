/**
 * Container item types that a media server can return from a library listing
 * but that are NOT playable media — collections, playlists and folder-ish
 * views. They carry no file, no streams and no size, so storing one as a
 * `MediaItem` produces a phantom row that pollutes library listings, dedup,
 * library stats and (worst) lifecycle rule matches.
 *
 * Plex is the server that actually leaks these: `/library/sections/{key}/all`
 * returns the section's collections alongside its movies unless an explicit
 * `type` filter is sent — and librariarr *creates* Plex collections itself
 * (see `src/lib/lifecycle/collections.ts`), so its own output would round-trip
 * back in as fake movies. Jellyfin/Emby filter server-side via
 * `IncludeItemTypes`, but the same guard is applied to every server so a
 * future listing change can't reintroduce the problem.
 *
 * Values are the normalized (lowercase) `MediaMetadataItem.type` strings:
 * Plex reports these verbatim, and `mapItemType()` in `jellyfin-base.ts`
 * lowercases unrecognized Jellyfin/Emby types (`BoxSet` → `boxset`, …).
 *
 * This is deliberately a deny-list rather than an allow-list of media types:
 * an unknown-but-real type (some server-specific media variant) must keep
 * syncing, whereas an over-eager allow-list would silently drop real media
 * and hand the sync's stale-item purge a library to wipe.
 */
export const NON_MEDIA_ITEM_TYPES: ReadonlySet<string> = new Set([
  "collection",
  "boxset",
  "playlist",
  "folder",
  "collectionfolder",
  "userview",
]);

/**
 * True when the item is real media that belongs in the `MediaItem` table.
 * Items with no `type` at all are kept — the field is optional on some server
 * responses and dropping them would lose real media.
 */
export function isMediaItem(item: { type?: string }): boolean {
  if (!item.type) return true;
  return !NON_MEDIA_ITEM_TYPES.has(item.type.toLowerCase());
}

/**
 * Split a listing into the media items to sync and the non-media containers to
 * skip. The caller needs the skipped count, not just the filtered list: the
 * sync engine's paging/stale-purge accounting compares processed items against
 * the server-reported total, which still counts the containers.
 */
export function partitionMediaItems<T extends { type?: string }>(
  items: T[],
): { media: T[]; skipped: number } {
  const media = items.filter(isMediaItem);
  return { media, skipped: items.length - media.length };
}
