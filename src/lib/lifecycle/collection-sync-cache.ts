/**
 * What one collection-sync pass reads from Plex once per library rather than
 * once per collection. Its own module, apart from `collections.ts`, so the
 * callers that create one (detection, the lifecycle processor) do not depend
 * on everything a test mocks that module down to.
 */

/** A Plex collection as its section listing reports it. */
export interface PlexCollectionRow {
  ratingKey: string;
  title: string;
  titleSort?: string;
  /** Plex's sort mode: "0" release date, "1" alphabetical, "2" custom. */
  collectionSort?: string | number;
}

export interface PlexShowRow {
  title: string;
  ratingKey: string;
}

/**
 * A library's shows (for series-scope matches) and its collection listing,
 * each read once per pass. Keyed by library ID — a section key repeats across
 * servers, so keyed by it one server's shows answered for another's.
 *
 * A collection the pass creates or deletes is reflected in the cached
 * listing, so a later sync in the same pass sees it as Plex now does.
 */
export class CollectionSyncCache {
  private readonly shows = new Map<string, Promise<PlexShowRow[]>>();
  private readonly listings = new Map<string, Promise<PlexCollectionRow[]>>();

  libraryShows(libraryId: string, load: () => Promise<PlexShowRow[]>): Promise<PlexShowRow[]> {
    return this.once(this.shows, libraryId, load);
  }

  collections(libraryId: string, load: () => Promise<PlexCollectionRow[]>): Promise<PlexCollectionRow[]> {
    // A copy: `created`/`deleted` edit the cached listing, never the loader's.
    return this.once(this.listings, libraryId, async () => [...(await load())]);
  }

  async created(libraryId: string, collection: PlexCollectionRow): Promise<void> {
    const listing = this.listings.get(libraryId);
    if (listing) (await listing).push(collection);
  }

  async deleted(libraryId: string, ratingKey: string): Promise<void> {
    const listing = this.listings.get(libraryId);
    if (!listing) return;
    const rows = await listing;
    const at = rows.findIndex((c) => c.ratingKey === ratingKey);
    if (at !== -1) rows.splice(at, 1);
  }

  private once<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    let pending = map.get(key);
    if (!pending) {
      pending = load();
      map.set(key, pending);
      // A failed read is not kept: the next collection asks again.
      pending.catch(() => {
        if (map.get(key) === pending) map.delete(key);
      });
    }
    return pending;
  }
}
