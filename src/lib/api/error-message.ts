/**
 * The message to show for a refused request, from its JSON body. A
 * validation failure answers `{ error: "Validation failed", details: ["field:
 * why", …] }`, and the bare `error` names neither the field nor the problem,
 * so the first detail is appended. Client-safe.
 */
export function responseErrorMessage(
  data: { error?: string; detail?: string; details?: unknown } | null | undefined,
  fallback: string,
): string {
  const first = Array.isArray(data?.details) ? data.details[0] : undefined;
  const detail =
    typeof first === "string"
      ? first
      : typeof (first as { message?: unknown } | undefined)?.message === "string"
        ? (first as { message: string }).message
        : data?.detail;
  const error = data?.error || fallback;
  return detail ? `${error} — ${detail}` : error;
}

/** {@link responseErrorMessage} for a `Response`, tolerating a non-JSON body. */
export async function readResponseError(resp: Response, fallback: string): Promise<string> {
  const data = await resp.json().catch(() => null);
  return responseErrorMessage(data, fallback);
}
