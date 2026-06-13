import { describe, it, expect, vi } from "vitest";
import { consumeProgressStream } from "@/lib/progress/client";
import type { ProgressUpdate } from "@/lib/progress/types";

/** Build a Response whose body streams the given chunks (as written). */
function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream);
}

function ndjson(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("consumeProgressStream", () => {
  it("forwards progress events and resolves with the result payload", async () => {
    const updates: ProgressUpdate[] = [];
    const response = streamingResponse([
      ndjson(
        { type: "plan", phases: [{ key: "a", label: "A" }] },
        { type: "phase", key: "a", fraction: 0.25 },
        { type: "result", result: { count: 2 } },
      ),
    ]);

    const result = await consumeProgressStream<{ count: number }>(response, (u) => updates.push(u));

    expect(result).toEqual({ count: 2 });
    expect(updates).toEqual([
      { type: "plan", phases: [{ key: "a", label: "A" }] },
      { type: "phase", key: "a", fraction: 0.25 },
    ]);
  });

  it("reassembles events split across chunk boundaries", async () => {
    const full = ndjson(
      { type: "phase", key: "a" },
      { type: "result", result: "done" },
    );
    // Split mid-line so the reader must buffer across reads.
    const mid = Math.floor(full.length / 3);
    const response = streamingResponse([full.slice(0, mid), full.slice(mid, mid + 5), full.slice(mid + 5)]);

    const onProgress = vi.fn();
    const result = await consumeProgressStream<string>(response, onProgress);

    expect(result).toBe("done");
    expect(onProgress).toHaveBeenCalledWith({ type: "phase", key: "a" });
  });

  it("handles a trailing result line with no terminating newline", async () => {
    const response = streamingResponse([JSON.stringify({ type: "result", result: 42 })]);
    const result = await consumeProgressStream<number>(response, () => {});
    expect(result).toBe(42);
  });

  it("throws with the error event's message", async () => {
    const response = streamingResponse([ndjson({ type: "error", message: "kaboom" })]);
    await expect(consumeProgressStream(response, () => {})).rejects.toThrow("kaboom");
  });

  it("throws when the stream ends without a result", async () => {
    const response = streamingResponse([ndjson({ type: "phase", key: "a" })]);
    await expect(consumeProgressStream(response, () => {})).rejects.toThrow("without a result");
  });

  it("throws when the response has no body", async () => {
    await expect(consumeProgressStream({ body: null } as Response, () => {})).rejects.toThrow("no body");
  });
});
