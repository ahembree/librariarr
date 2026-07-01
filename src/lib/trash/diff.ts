import type { DiffEntry } from "./types";

/**
 * Recursively diff two JSON-like values into a flat list of changed paths.
 * Used to show the user exactly what a sync would change (and to power the
 * dry-run preview). Callers pass normalized "comparable" objects so the diff
 * reflects meaningful changes rather than incidental field ordering / ids.
 */
export function diffValues(before: unknown, after: unknown, path = ""): DiffEntry[] {
  if (isEqual(before, after)) return [];

  const bothObjects =
    isPlainObject(before) && isPlainObject(after);
  const bothArrays = Array.isArray(before) && Array.isArray(after);

  if (bothObjects) {
    const entries: DiffEntry[] = [];
    const keys = new Set([
      ...Object.keys(before as object),
      ...Object.keys(after as object),
    ]);
    for (const key of [...keys].sort()) {
      const child = path ? `${path}.${key}` : key;
      entries.push(
        ...diffValues(
          (before as Record<string, unknown>)[key],
          (after as Record<string, unknown>)[key],
          child,
        ),
      );
    }
    return entries;
  }

  if (bothArrays) {
    const entries: DiffEntry[] = [];
    const a = before as unknown[];
    const b = after as unknown[];
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      entries.push(...diffValues(a[i], b[i], `${path}[${i}]`));
    }
    return entries;
  }

  const kind: DiffEntry["kind"] =
    before === undefined ? "added" : after === undefined ? "removed" : "changed";
  return [{ path: path || "(root)", before, after, kind }];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => isEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => isEqual(a[k], b[k]));
  }
  return false;
}
