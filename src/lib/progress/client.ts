import type { ProgressUpdate } from "./types";

/**
 * Consume an NDJSON progress stream produced by `progressStreamResponse`.
 *
 * Forwards each `plan`/`phase` event to `onProgress` and resolves with the
 * payload of the terminal `result` event. Throws if the response is non-OK, if
 * the stream emits an `error` event, or if it ends without a result.
 *
 * The non-OK check is not optional politeness. Auth, validation and safety
 * refusals (the lifecycle evaluability guard among them) are answered as plain
 * JSON `{ error }` BEFORE the stream opens, so the body is not NDJSON at all:
 * that single line parses as an event with no `type`, falls through every
 * branch, and the reader then reports "Stream ended without a result" — the
 * server's actual reason silently discarded and replaced by a generic parse
 * complaint. Every caller would have to remember to pre-check `response.ok` to
 * avoid it; reading the reason here means none of them can forget.
 */
export async function consumeProgressStream<T>(
  response: Response,
  onProgress: (update: ProgressUpdate) => void,
): Promise<T> {
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `Request failed with status ${response.status}`);
  }
  if (!response.body) throw new Error("Response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: T | undefined;
  let hasResult = false;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const event = JSON.parse(trimmed) as
      | ProgressUpdate
      | { type: "result"; result: T }
      | { type: "error"; message: string };
    if (event.type === "plan" || event.type === "phase") {
      onProgress(event);
    } else if (event.type === "result") {
      result = event.result;
      hasResult = true;
    } else if (event.type === "error") {
      throw new Error(event.message);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(line);
      }
    }
    // Flush any trailing line without a newline terminator.
    if (buffer.trim()) handleLine(buffer);
  } finally {
    // Release/cancel the reader on every exit path (error event, parse failure,
    // or normal completion) so the response body isn't left locked/leaked.
    reader.cancel().catch(() => {});
  }

  if (!hasResult) throw new Error("Stream ended without a result");
  return result as T;
}
