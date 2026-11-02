/** A library type, as `Library.type` stores it. */
export type SyncLibraryType = "MOVIE" | "SERIES" | "MUSIC";

/**
 * The `meta` of a `sync:completed` event.
 *
 * `libraryTypes` names the library types whose rows the run wrote or removed,
 * so a page that shows only another type can skip refetching its whole list.
 * It is a scope, not a figure: it says WHAT may have changed, never how much.
 * Absent means unknown — the run could not say (it touched no library, or it
 * predates the field) — and a receiver then refetches exactly as it always did.
 */
// A type alias rather than an interface so it is assignable to the event's
// `Record<string, unknown>` meta.
export type SyncCompletedMeta = {
  serverId: string;
  /** Set by the realtime incremental sync. */
  incremental?: true;
  libraryTypes?: SyncLibraryType[];
};

export function syncCompletedMeta(
  serverId: string,
  types: Iterable<SyncLibraryType>,
  extra: { incremental?: true } = {},
): SyncCompletedMeta {
  const libraryTypes = [...new Set(types)].sort();
  return {
    serverId,
    ...extra,
    ...(libraryTypes.length > 0 ? { libraryTypes } : {}),
  };
}
