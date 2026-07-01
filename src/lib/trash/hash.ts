import { createHash } from "node:crypto";

/** Deterministic JSON stringify with sorted object keys (stable across runs). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

/** Short stable hash of a definition, used to detect upstream guide changes. */
export function hashDefinition(value: unknown): string {
  return createHash("sha1").update(stableStringify(value)).digest("hex").slice(0, 16);
}
