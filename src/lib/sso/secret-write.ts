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
  if (incoming === "") return null;
  if (/^•+$/.test(incoming)) return current;
  const trimmed = incoming.trim();
  return trimmed === "" ? null : trimmed;
}
