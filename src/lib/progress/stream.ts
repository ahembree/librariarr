import type { ProgressEmit } from "./types";

// Hard cap so a single progress stream can never pin a connection / keep doing
// expensive work indefinitely, even if the client never disconnects cleanly.
const DEFAULT_MAX_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Run a multi-phase task and stream its progress to the client as NDJSON.
 *
 * The `run` callback receives an `emit` it can call to report `plan`/`phase`
 * events, plus an `AbortSignal` it should honor (check `signal.aborted` in long
 * loops) so the work stops when the client disconnects or the lifetime cap
 * fires. Its resolved value is sent as a final `{ type: "result", result }`
 * line. A thrown error becomes a `{ type: "error", message }` line (the HTTP
 * status stays 200 — the stream has already begun, so errors are in-band, same
 * as the backup-restore route).
 *
 * Cancellation: the stream's `cancel()` (client navigated away / aborted) and a
 * `maxLifetimeMs` timeout both abort the signal, so the underlying work — full
 * Arr/Seerr sweeps and whole-library evaluation — stops instead of running to
 * completion and pinning resources.
 */
export function progressStreamResponse<T>(
  run: (emit: ProgressEmit, signal: AbortSignal) => Promise<T>,
  options?: { signal?: AbortSignal; maxLifetimeMs?: number },
): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();

  // Link the request's signal (client disconnect at the fetch layer) to ours.
  const external = options?.signal;
  if (external) {
    if (external.aborted) abort.abort();
    else external.addEventListener("abort", () => abort.abort(), { once: true });
  }

  return new Response(
    new ReadableStream({
      async start(controller) {
        let closed = false;
        const maxLifetime = options?.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
        const lifetimeTimer = setTimeout(() => abort.abort(), maxLifetime);

        const send = (event: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          } catch {
            // Stream may already be closed (client navigated away).
          }
        };

        try {
          const result = await run((update) => send(update), abort.signal);
          send({ type: "result", result });
        } catch (err) {
          // If we aborted (client gone / lifetime cap), there's no one to read
          // an error line — skip it.
          if (!abort.signal.aborted) {
            send({
              type: "error",
              message: err instanceof Error ? err.message : "Request failed",
            });
          }
        } finally {
          clearTimeout(lifetimeTimer);
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
      cancel() {
        // Client disconnected — abort so the underlying work stops instead of
        // running to completion.
        abort.abort();
      },
    }),
    {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    },
  );
}
