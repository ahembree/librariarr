import { constants as zlibConstants, createGzip, type Gzip } from "node:zlib";
import { acceptsGzip, writeJsonYielding } from "@/lib/api/json-response";
import type { ProgressEmit } from "./types";

// Hard cap so a single progress stream can never pin a connection / keep doing
// expensive work indefinitely, even if the client never disconnects cleanly.
const DEFAULT_MAX_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes

// A run can go a long time without an event (a slow AI model turn, a big query
// or tool call). Reverse proxies drop a response that stays idle (often
// 60–100 s), so a `{ type: "heartbeat" }` line is written whenever nothing else
// has been for this long. Readers ignore event types they don't know.
export const HEARTBEAT_INTERVAL_MS = 15_000;

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
 * proxy has nothing held back to wait on. The result line is serialised and
 * written a slice at a time (`writeJsonYielding`), so a long one never holds
 * the event loop for the whole list, nor exists as one string.
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

  const gzipped = !!options?.request && acceptsGzip(options.request.headers.get("accept-encoding"));
  let gzip: Gzip | null = null;

  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const maxLifetime = options?.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
        const lifetimeTimer = setTimeout(() => abort.abort(), maxLifetime);

        if (gzipped) {
          // Every finished line is followed by a sync flush, so it is on the
          // wire (and decodable) before the next event exists. The pieces of
          // a result line are not: a flush per piece would cost a block
          // boundary per "," and key the serializer writes.
          gzip = createGzip({ level: GZIP_LEVEL });
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

        const write = (chunk: string, endsLine = true) => {
          if (closed) return;
          if (gzip) {
            gzip.write(chunk);
            if (endsLine) gzip.flush(zlibConstants.Z_SYNC_FLUSH);
            return;
          }
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
          await writeJsonYielding({ type: "result", result }, (piece) => write(piece, false));
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
            if (resultLineOpen) write("\n", false);
            send({
              type: "error",
              message: err instanceof Error ? err.message : "Request failed",
            });
          }
        } finally {
          stopHeartbeat();
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
        readerLeft();
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
