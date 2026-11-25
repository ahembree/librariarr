/**
 * Plex collection ordering: the fields a collection can be sorted by, the
 * direction, and which combinations Plex can hold natively. Client-safe — the
 * rule editor reads the options from here.
 *
 * Plex itself sorts a collection three ways only (`collectionSort`): 0 release
 * date and 1 alphabetical (both ascending), and 2 custom (the order the items
 * were moved into). Every other field, and either native field descending, is
 * kept as a custom order that the sync computes and applies with the fewest
 * `move`s (`planCollectionMoves`).
 */

export const COLLECTION_SORT_FIELDS = [
  "ALPHABETICAL",
  "RELEASE_DATE",
  "DATE_ADDED",
  "ACTION_DATE",
  "LAST_PLAYED",
  "PLAY_COUNT",
  "FILE_SIZE",
  "DURATION",
  "CRITIC_RATING",
  "AUDIENCE_RATING",
  "USER_RATING",
] as const;

export type CollectionSortField = (typeof COLLECTION_SORT_FIELDS)[number];

export const COLLECTION_SORT_DIRECTIONS = ["asc", "desc"] as const;

export type CollectionSortDirection = (typeof COLLECTION_SORT_DIRECTIONS)[number];

export const DEFAULT_COLLECTION_SORT: CollectionSortField = "ALPHABETICAL";
export const DEFAULT_COLLECTION_SORT_DIRECTION: CollectionSortDirection = "asc";

export const COLLECTION_SORT_OPTIONS: ReadonlyArray<{ value: CollectionSortField; label: string }> = [
  { value: "ALPHABETICAL", label: "Title" },
  { value: "RELEASE_DATE", label: "Release date" },
  { value: "DATE_ADDED", label: "Date added" },
  { value: "ACTION_DATE", label: "Action date" },
  { value: "LAST_PLAYED", label: "Last played" },
  { value: "PLAY_COUNT", label: "Play count" },
  { value: "FILE_SIZE", label: "File size" },
  { value: "DURATION", label: "Duration" },
  { value: "CRITIC_RATING", label: "Critic rating" },
  { value: "AUDIENCE_RATING", label: "Audience rating" },
  { value: "USER_RATING", label: "User rating" },
];

export const COLLECTION_SORT_DIRECTION_OPTIONS: ReadonlyArray<{ value: CollectionSortDirection; label: string }> = [
  { value: "asc", label: "Ascending" },
  { value: "desc", label: "Descending" },
];

export function isCollectionSortField(value: unknown): value is CollectionSortField {
  return typeof value === "string" && (COLLECTION_SORT_FIELDS as readonly string[]).includes(value);
}

/** A stored sort, read leniently: an unknown field is alphabetical. */
export function collectionSortFieldOf(value: unknown): CollectionSortField {
  return isCollectionSortField(value) ? value : DEFAULT_COLLECTION_SORT;
}

/** A stored direction, read leniently: anything but "desc" is ascending. */
export function collectionSortDirectionOf(value: unknown): CollectionSortDirection {
  return value === "desc" ? "desc" : "asc";
}

/** Plex's own sort mode for a field and direction: 0 release date, 1 alphabetical, 2 custom. */
export function plexCollectionSortMode(field: CollectionSortField, direction: CollectionSortDirection): 0 | 1 | 2 {
  if (direction === "asc" && field === "RELEASE_DATE") return 0;
  if (direction === "asc" && field === "ALPHABETICAL") return 1;
  return 2;
}

/** Whether the sync orders the collection itself (Plex's custom mode). */
export function needsCustomOrder(field: CollectionSortField, direction: CollectionSortDirection): boolean {
  return plexCollectionSortMode(field, direction) === 2;
}

export type CollectionSortValue = number | string | null | undefined;

/**
 * Compare two sort values in `direction`. An item without a value sorts last
 * in either direction; 0 means a tie (the caller breaks it).
 */
export function compareCollectionSortValues(
  a: CollectionSortValue,
  b: CollectionSortValue,
  direction: CollectionSortDirection,
): number {
  const aMissing = a == null || (typeof a === "number" && Number.isNaN(a));
  const bMissing = b == null || (typeof b === "number" && Number.isNaN(b));
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  let cmp: number;
  if (typeof a === "number" && typeof b === "number") {
    cmp = a === b ? 0 : a < b ? -1 : 1;
  } else {
    cmp = String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
  }
  if (cmp === 0) return 0;
  return direction === "desc" ? -cmp : cmp;
}
