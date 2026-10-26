import { constants as zlibConstants, createGzip, type Gzip } from "node:zlib";
import { acceptsGzip, stringifyYielding } from "@/lib/api/json-response";
import type { ProgressEmit } from "./types";

// Hard cap so a single progress stream can never pin a connection / keep doing
// expensive work indefinitely, even if the client never disconnects cleanly.
const DEFAULT_MAX_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes

/** zlib level, as `jsonResponse` compresses lists (see json-response.ts). */
const GZIP_LEVEL = 3;

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
 * like `signal`, and when it accepts gzip the stream is gzipped. The result
 * line is the large part — a query's or a rule preview's whole match list,
 * which compresses as the JSON lists do (7–9×) — and Next.js leaves Route
 * Handler responses uncompressed. Every line is written with a zlib SYNC
 * flush, so each progress event leaves as soon as it is emitted, as a
 * complete, decodable block: a browser's `fetch` reader gets it at once, and a
 * proxy has nothing held back to wait on. The result line is serialised a
 * slice at a time (`stringifyYielding`), so a long one never holds the event
 * loop for the whole list.
 */
export function progressStreamResponse<T>(
  run: (emit: ProgressEmit, signal: AbortSignal) => Promise<T>,
  options?: { signal?: AbortSignal; maxLifetimeMs?: number; request?: Request },
): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();

  // Link the request's signal (client disconnect at the fetch layer) to ours.
  for (const external of [options?.signal, options?.request?.signal]) {
    if (!external) continue;
    if (external.aborted) abort.abort();
    else external.addEventListener("abort", () => abort.abort(), { once: true });
  }

  const gzipped = !!options?.request && acceptsGzip(options.request.headers.get("accept-encoding"));
  let gzip: Gzip | null = null;

  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const maxLifetime = options?.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
        const lifetimeTimer = setTimeout(() => abort.abort(), maxLifetime);

        if (gzipped) {
          // Every write is followed by a sync flush, so what was written is on
          // the wire (and decodable) before the next event exists.
          gzip = createGzip({ level: GZIP_LEVEL, flush: zlibConstants.Z_SYNC_FLUSH });
          gzip.on("data", (chunk: Buffer) => {
            if (closed) return;
            try {
              controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            } catch {
              // Stream may already be closed (client navigated away).
            }
          });
          // Nothing to recover: the stream ends with what was written.
          gzip.on("error", () => {});
        }

        const write = (line: string) => {
          if (closed) return;
          if (gzip) {
            gzip.write(line);
            return;
          }
          try {
            controller.enqueue(encoder.encode(line));
          } catch {
            // Stream may already be closed (client navigated away).
          }
        };
        const send = (event: unknown) => write(JSON.stringify(event) + "\n");

        try {
          const result = await run((update) => send(update), abort.signal);
          write((await stringifyYielding({ type: "result", result })) + "\n");
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
          // The gzip trailer, after every block written above has been read
          // out of zlib.
          const finishing = gzip;
          if (finishing && !finishing.destroyed) {
            await new Promise<void>((resolve) => {
              finishing.once("end", resolve);
              finishing.once("close", resolve);
              finishing.end();
            });
          }
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
        gzip?.destroy();
      },
    }),
    {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        ...(options?.request ? { Vary: "Accept-Encoding" } : {}),
        ...(gzipped ? { "Content-Encoding": "gzip" } : {}),
      },
    },
  );
}
