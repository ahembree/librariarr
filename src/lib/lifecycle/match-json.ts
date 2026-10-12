/**
 * `{ ...itemData, detectedAt }` as JSON text, built from the snapshot's stored
 * JSON text (`"itemData"::text`) rather than from a parsed copy of it.
 *
 * A match's `itemData` is the whole item row detection saw — about 2 KB per
 * movie, more for a show or artist with its member ids — and the Matches page
 * reads every match. Parsing each one into an object only to serialise it
 * straight back cost ~550 ms on 11.4k matches, against ~280 ms for reading the
 * text and splicing the timestamp in.
 *
 * The result parses to exactly what the spread produced. A snapshot that
 * already holds a `detectedAt` key keeps it in place and takes the stamp's
 * value, as the spread did, because a JSON parser keeps the first position of
 * a repeated key and its last value. Anything that is not a JSON object
 * (a legacy null, say) goes through the spread itself.
 */
export function matchItemJson(itemJson: string | null, detectedAt: Date): string {
  const stamp = `"detectedAt":${JSON.stringify(detectedAt.toISOString())}`;
  const text = itemJson?.trim() ?? "";
  if (!text.startsWith("{") || !text.endsWith("}")) {
    const parsed: unknown = text ? JSON.parse(text) : null;
    return JSON.stringify({ ...(parsed as Record<string, unknown>), detectedAt: detectedAt.toISOString() });
  }
  const inner = text.slice(1, -1).trim();
  return `{${inner}${inner ? "," : ""}${stamp}}`;
}
