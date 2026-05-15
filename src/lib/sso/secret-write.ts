/**
 * Resolve what to write to a sensitive field (like `oidcClientSecret`) based
 * on the incoming PUT payload:
 *
 *   undefined           → field not sent — keep the existing value
 *   masked placeholder  → GET sanitized this; the client echoed it back — keep
 *   null or ""          → explicit clear — write null
 *   anything else       → write trimmed value (or null if it trims to empty)
 *
 * Without this distinction a partial PUT that omits the field silently wipes
 * the stored secret.
 */
export function resolveSecretWrite(
  incoming: string | null | undefined,
  current: string | null,
): string | null {
  if (incoming === undefined) return current;
  if (incoming === null) return null;
  // Trim *before* the masked-placeholder check. Otherwise a user who
  // accidentally copy/pastes the displayed mask with trailing whitespace
  // (e.g. `"••••••••  "`) would fail the anchored `^•+$` test and we'd
  // silently overwrite the real secret with literal bullet characters.
  const trimmed = incoming.trim();
  if (trimmed === "") return null;
  if (/^•+$/.test(trimmed)) return current;
  return trimmed;
}
