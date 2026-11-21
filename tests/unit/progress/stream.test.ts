import { describe, it, expect, vi, afterEach } from "vitest";
import { progressStreamResponse, HEARTBEAT_INTERVAL_MS } from "@/lib/progress/stream";

async function readLines(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("progressStreamResponse", () => {
  // A slow run writes nothing for minutes; the heartbeat keeps reverse proxies
  // from closing the idle stream, and stops once the run settles.
  it("writes heartbeats while the run is quiet, none while it is busy or after it ends", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (v: { ok: true }) => void;
      let emitNow!: (u: { type: "phase"; key: string }) => void;
      const response = progressStreamResponse((emit) => {
        emitNow = emit;
        return new Promise((r) => { finish = r; });
      });
      const text = response.text();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
      // Busy: an event every half interval leaves no gap for a heartbeat.
      for (let i = 0; i < 4; i++) {
        emitNow({ type: "phase", key: `p${i}` });
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS / 2);
      }
      finish({ ok: true });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
      const types = (await text).split("\n").filter(Boolean).map((l) => JSON.parse(l).type);
      expect(types).toEqual(["heartbeat", "heartbeat", "heartbeat", "phase", "phase", "phase", "phase", "result"]);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("ends a result line that failed to serialize part-way, so the error event is its own line", async () => {
    // A long list is written a slice at a time, so slices before the bad row
    // are already sent when serializing it throws.
    const rows: unknown[] = Array.from({ length: 3000 }, (_, i) => ({ i }));
    rows[2500] = { i: 10n };
    const response = progressStreamResponse(async () => ({ rows }));

    const lines = (await response.text()).split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('{"type":"result"')).toBe(true);
    expect(() => JSON.parse(lines[0])).toThrow();
    expect(JSON.parse(lines[1])).toEqual({ type: "error", message: expect.stringContaining("BigInt") });
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

    it("aborts the task's signal at the lifetime cap, and tells the reader still there why it ended", async () => {
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
      // The client is still reading: it gets the reason, not a stream that
      // ends without a result.
      expect(await read).toEqual([{ type: "error", message: "aborted" }]);
    });

    it("still sends the error of a run that goes on past the lifetime cap and fails", async () => {
      vi.useFakeTimers();
      let fail!: (error: Error) => void;
      // Ignores the signal (as a lifecycle Execute does: it must not stop
      // half-way through a delete).
      const response = progressStreamResponse(
        () => new Promise((_resolve, reject) => { fail = reject; }),
        { maxLifetimeMs: 1_000 },
      );
      const read = readLines(response);
      await vi.advanceTimersByTimeAsync(5_000);
      fail(new Error("database went away"));
      await vi.advanceTimersByTimeAsync(0);
      expect(await read).toContainEqual({ type: "error", message: "database went away" });
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

    it("aborts the task when the request passed as `request` is aborted", async () => {
      const controller = new AbortController();
      const request = new Request("http://localhost/api/x", { signal: controller.signal });
      let seen: AbortSignal | undefined;
      const response = progressStreamResponse(
        (_emit, signal) =>
          new Promise((_resolve, reject) => {
            seen = signal;
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        { request },
      );
      const read = readLines(response);
      await Promise.resolve();
      controller.abort();
      expect(seen?.aborted).toBe(true);
      expect(await read).toEqual([]);
    });
  });

  describe("encoding", () => {
    // Next.js drops a Route Handler's own Content-Encoding (GHSA-pc58-hwjq-p385),
    // so a gzipped stream would reach the reader as raw deflate bytes.
    const gzipRequest = () =>
      new Request("http://localhost/api/x", { headers: { "Accept-Encoding": "gzip, deflate, br" } });

    it("streams plain NDJSON even to a request that accepts gzip", async () => {
      const response = progressStreamResponse(async (emit) => {
        emit({ type: "phase", key: "a", fraction: 0.5 });
        return { ok: true };
      }, { request: gzipRequest() });
      expect(response.headers.get("Content-Encoding")).toBeNull();
      expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
      expect(await readLines(response)).toEqual([
        { type: "phase", key: "a", fraction: 0.5 },
        { type: "result", result: { ok: true } },
      ]);
    });

    it("sends each progress event at once, before the task finishes", async () => {
      let finish!: () => void;
      const done = new Promise<void>((resolve) => (finish = resolve));
      const response = progressStreamResponse(
        async (emit) => {
          emit({ type: "phase", key: "a", fraction: 0.25 });
          await done;
          emit({ type: "phase", key: "a", fraction: 1 });
          return { ok: true };
        },
        { request: gzipRequest() },
      );

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("\n")) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        text += decoder.decode(value, { stream: true });
      }
      expect(JSON.parse(text.trim())).toEqual({ type: "phase", key: "a", fraction: 0.25 });

      finish();
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        text += decoder.decode(value, { stream: true });
      }
      expect(text.trim().split("\n").map((l) => JSON.parse(l).type)).toEqual(["phase", "phase", "result"]);
    });
  });
});
