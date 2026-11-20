import { writeJsonYielding } from "@/lib/api/json-response";
import type { ProgressEmit } from "./types";

// Hard cap so a single progress stream can never pin a connection / keep doing
// expensive work indefinitely, even if the client never disconnects cleanly.
const DEFAULT_MAX_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes

// A run can go a long time without an event (a slow AI model turn, a big query
// or tool call). Reverse proxies drop a response that stays idle (often
// 60–100 s), so a `{ type: "heartbeat" }` line is written whenever nothing else
// has been for this long. Readers ignore event types they don't know.
export const HEARTBEAT_INTERVAL_MS = 15_000;

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
 *
 * `request` (optional): the request being answered. Its signal aborts the run
 * like `signal`. The stream is sent uncompressed: since 16.4.5 Next.js drops a
 * Route Handler's own `Content-Encoding` (GHSA-pc58-hwjq-p385), so a gzipped
 * body would reach the reader as raw deflate bytes, and Next.js does not
 * compress `application/x-ndjson` itself — which also keeps every line on the
 * wire the moment it is written, with nothing held back in a compressor. The
 * result line is serialised and written a slice at a time
 * (`writeJsonYielding`), so a long one never holds the event loop for the
 * whole list, nor exists as one string.
 */
export function progressStreamResponse<T>(
  run: (emit: ProgressEmit, signal: AbortSignal) => Promise<T>,
  options?: { signal?: AbortSignal; maxLifetimeMs?: number; request?: Request },
): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  // Set when no one is reading any more (the client went, or the caller's
  // signal said so) — not by the lifetime cap, which only asks the run to
  // stop: a run that ignores it and fails later still has a reader waiting
  // for the reason.
  let readerGone = false;
  const readerLeft = () => {
    readerGone = true;
    abort.abort();
  };

  // Link the request's signal (client disconnect at the fetch layer) to ours.
  for (const external of [options?.signal, options?.request?.signal]) {
    if (!external) continue;
    if (external.aborted) readerLeft();
    else external.addEventListener("abort", readerLeft, { once: true });
  }

  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const maxLifetime = options?.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
        const lifetimeTimer = setTimeout(() => abort.abort(), maxLifetime);

        const write = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // Stream may already be closed (client navigated away).
          }
        };
        let lastWriteAt = Date.now();
        const send = (event: unknown) => {
          lastWriteAt = Date.now();
          write(JSON.stringify(event) + "\n");
        };
        // Runs only while `run` is pending: the result line is written a piece
        // at a time across event-loop turns, and a heartbeat must not land
        // inside it.
        const heartbeat = setInterval(() => {
          if (Date.now() - lastWriteAt >= HEARTBEAT_INTERVAL_MS) send({ type: "heartbeat" });
        }, HEARTBEAT_INTERVAL_MS);
        const stopHeartbeat = () => clearInterval(heartbeat);

        // Set once the result line has begun: it is written a piece at a time,
        // so a value that fails to serialize part-way leaves it unterminated.
        let resultLineOpen = false;
        try {
          const result = await run((update) => send(update), abort.signal);
          stopHeartbeat();
          resultLineOpen = true;
          await writeJsonYielding({ type: "result", result }, (piece) => write(piece));
          resultLineOpen = false;
          write("\n");
        } catch (err) {
          // With the client gone there's no one to read an error line — skip
          // it. Past the lifetime cap the client is still reading (a run that
          // does not stop on the signal, like a lifecycle Execute, goes on), so
          // the reason is still sent.
          if (!readerGone) {
            // End the broken result line, so the error event is a line of its
            // own the reader can still parse.
            if (resultLineOpen) write("\n");
            send({
              type: "error",
              message: err instanceof Error ? err.message : "Request failed",
            });
          }
        } finally {
          stopHeartbeat();
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
        readerLeft();
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
