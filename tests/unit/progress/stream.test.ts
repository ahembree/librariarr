import { describe, it, expect, vi, afterEach } from "vitest";
import { progressStreamResponse } from "@/lib/progress/stream";

async function readLines(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("progressStreamResponse", () => {
  it("sets NDJSON streaming headers", () => {
    const response = progressStreamResponse(async () => ({ ok: true }));
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
  });

  it("streams emitted progress events followed by the result", async () => {
    const response = progressStreamResponse(async (emit) => {
      emit({ type: "plan", phases: [{ key: "a", label: "A" }, { key: "b", label: "B" }] });
      emit({ type: "phase", key: "a" });
      emit({ type: "phase", key: "b", fraction: 0.5 });
      return { items: [1, 2, 3] };
    });

    const events = await readLines(response);
    expect(events.map((e) => e.type)).toEqual(["plan", "phase", "phase", "result"]);
    expect(events[2]).toEqual({ type: "phase", key: "b", fraction: 0.5 });
    expect(events[3]).toEqual({ type: "result", result: { items: [1, 2, 3] } });
  });

  it("emits an error event (not a result) when the task throws", async () => {
    const response = progressStreamResponse(async (emit) => {
      emit({ type: "phase", key: "a" });
      throw new Error("boom");
    });

    const events = await readLines(response);
    expect(events.map((e) => e.type)).toEqual(["phase", "error"]);
    expect(events[1]).toEqual({ type: "error", message: "boom" });
    expect(events.some((e) => e.type === "result")).toBe(false);
  });

  it("falls back to a generic message for non-Error throws", async () => {
    const response = progressStreamResponse(async () => {
      throw "nope";
    });
    const events = await readLines(response);
    expect(events).toEqual([{ type: "error", message: "Request failed" }]);
  });

  describe("cancellation", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("aborts the task's signal at the lifetime cap and sends no error line for it", async () => {
      vi.useFakeTimers();
      let seen: AbortSignal | undefined;
      const response = progressStreamResponse(
        (_emit, signal) =>
          new Promise((_resolve, reject) => {
            seen = signal;
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        { maxLifetimeMs: 1_000 },
      );
      const read = readLines(response);
      await vi.advanceTimersByTimeAsync(999);
      expect(seen?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(seen?.aborted).toBe(true);
      // Nobody is left to read an error, so the stream just ends.
      expect(await read).toEqual([]);
    });

    it("aborts the task's signal when the request's signal aborts", async () => {
      const request = new AbortController();
      let seen: AbortSignal | undefined;
      const response = progressStreamResponse(
        (_emit, signal) =>
          new Promise((_resolve, reject) => {
            seen = signal;
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        { signal: request.signal },
      );
      const read = readLines(response);
      await Promise.resolve();
      expect(seen?.aborted).toBe(false);
      request.abort();
      expect(seen?.aborted).toBe(true);
      expect(await read).toEqual([]);
    });
  });
});
