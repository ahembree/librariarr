import type { ProgressEmit } from "./types";

/**
 * Run a multi-phase task and stream its progress to the client as NDJSON.
 *
 * The `run` callback receives an `emit` it can call to report `plan`/`phase`
 * events; its resolved value is sent as a final `{ type: "result", result }`
 * line. Any thrown error becomes a `{ type: "error", message }` line (the HTTP
 * status stays 200 — the stream has already begun, so errors are in-band, same
 * as the backup-restore route).
 */
export function progressStreamResponse<T>(
  run: (emit: ProgressEmit) => Promise<T>,
): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (event: unknown) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          } catch {
            // Stream may already be closed (client navigated away).
          }
        };

        try {
          const result = await run((update) => send(update));
          send({ type: "result", result });
        } catch (err) {
          send({
            type: "error",
            message: err instanceof Error ? err.message : "Request failed",
          });
        } finally {
          controller.close();
        }
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
