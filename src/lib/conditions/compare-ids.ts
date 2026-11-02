/**
 * The order the engines pick a group's stable representative by — "the lowest
 * id" — as a plain code-unit comparison. Ids are cuids (lowercase base36), on
 * which this agrees with `localeCompare`; it is used because a group sort over
 * a library's worth of rows ran an ICU collation per comparison. Every place
 * that picks a lowest id compares through this, so they cannot disagree.
 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
