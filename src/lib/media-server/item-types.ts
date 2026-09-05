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
 * The one item type each library type stores as a `MediaItem`. The full sync
 * enforces this server-side — it lists a library with exactly one type filter
 * (Plex `type=1/4/10`, Jellyfin `IncludeItemTypes=Movie/Episode/Audio`) — so a
 * SERIES library holds episodes, never the shows or seasons above them.
 *
 * The incremental sync has no such filter: it fetches whatever rating keys a
 * `library-changed` event carried, and a single new episode makes Plex emit
 * timeline entries for the episode AND its season AND its show (Jellyfin's
 * `LibraryChanged.ItemsAdded` likewise). Those are real media, not containers,
 * so `isMediaItem` passes them — hence this second, stricter check.
 */
const LIBRARY_ITEM_TYPE = {
  MOVIE: "movie",
  SERIES: "episode",
  MUSIC: "track",
} as const;

/**
 * True when the item is the type its library actually stores.
 *
 * Anything the full sync would not have listed must not be written by the
 * incremental sync either — a row the periodic full sync then purges as stale
 * is a phantom entry in the UI until it runs.
 *
 * Items with no `type` are kept, as in `isMediaItem`: the server already
 * type-filtered the listing they came from, so a missing field is a gap in the
 * response, not evidence of the wrong type.
 */
export function isItemForLibraryType(
  item: { type?: string },
  libraryType: keyof typeof LIBRARY_ITEM_TYPE,
): boolean {
  if (!item.type) return true;
  return item.type.toLowerCase() === LIBRARY_ITEM_TYPE[libraryType];
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

/**
 * Item types that can belong to a library librariarr actually syncs.
 *
 * `PlexClient.getLibraries()` keeps only `movie` / `show` / `artist` sections,
 * so a Plex server's Photos or Home Videos section never gets a `Library` row —
 * ever, by design. That matters because the incremental sync treats "this item
 * names a library section we have no row for" as evidence a NEW library
 * appeared and escalates to a full sync to create it. For a photo that
 * escalation can never succeed: the full sync won't create the row either, so
 * the next photo escalates again, forever — a full-server sync per photo, which
 * is precisely the failure the incremental path exists to prevent.
 *
 * This is an ALLOW-list where the module's other guards are deny-lists, and the
 * asymmetry is deliberate: it gates only ESCALATION, never syncing. An
 * unknown-but-real type with an unknown section is counted `unresolved` and left
 * for the scheduled full sync, which is the safe direction — the alternative
 * failure mode is an unbounded sync loop.
 */
const SYNCABLE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "movie",
  "show", "season", "episode",
  "artist", "album", "track",
]);

/**
 * True when an item could plausibly live in a MOVIE / SERIES / MUSIC library —
 * i.e. when an unrecognized library section is worth a full sync to discover.
 */
export function canBelongToSyncedLibrary(item: { type?: string }): boolean {
  if (!item.type) return true;
  return SYNCABLE_ITEM_TYPES.has(item.type.toLowerCase());
}
