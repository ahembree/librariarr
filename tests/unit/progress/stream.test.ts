import { describe, it, expect, vi, afterEach } from "vitest";
import { createGunzip, gunzipSync } from "node:zlib";
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

  describe("gzip", () => {
    const gzipRequest = (acceptEncoding = "gzip, deflate, br") =>
      new Request("http://localhost/api/x", { headers: { "Accept-Encoding": acceptEncoding } });

    /** A large result, shaped like a query's rows. */
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `cm${String(i).padStart(10, "0")}xyz`,
        title: `Movie ${i}`,
        year: 1950 + (i % 75),
        resolution: ["4K", "1080P", "720P"][i % 3],
        matchedCriteria: [{ field: "playCount", operator: "equals", value: "0" }],
        fileSize: String(i * 1_000_003),
      }));

    it("gzips the stream for a request that accepts it, and decodes to the same lines", async () => {
      const run = async (emit: Parameters<Parameters<typeof progressStreamResponse>[0]>[0]) => {
        emit({ type: "plan", phases: [{ key: "a", label: "A" }] });
        emit({ type: "phase", key: "a", fraction: 0.5, detail: "half" });
        return { items: rows(3000) };
      };
      const plain = progressStreamResponse(run);
      const zipped = progressStreamResponse(run, { request: gzipRequest() });

      expect(zipped.headers.get("Content-Encoding")).toBe("gzip");
      expect(zipped.headers.get("Vary")).toBe("Accept-Encoding");
      const plainBytes = Buffer.from(await plain.arrayBuffer());
      const zippedBytes = Buffer.from(await zipped.arrayBuffer());
      const decoded = gunzipSync(zippedBytes);
      expect(decoded.toString()).toBe(plainBytes.toString());
      // 3,000 query rows: ~490 KB as NDJSON, well under a tenth of that gzipped.
      expect(zippedBytes.byteLength).toBeLessThan(plainBytes.byteLength / 8);
    });

    it("sends each progress event at once, decodable before the task finishes", async () => {
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
      const gunzip = createGunzip();
      let decoded = "";
      gunzip.on("data", (chunk: Buffer) => (decoded += chunk.toString()));
      // Everything the stream sends goes straight to the decoder.
      const pumped = (async () => {
        for (;;) {
          const { value, done: ended } = await reader.read();
          if (ended) break;
          gunzip.write(value);
        }
        await new Promise<void>((resolve) => gunzip.end(resolve));
      })();

      // The first event arrives — and decodes — while the task is still waiting.
      for (let i = 0; i < 200 && !decoded.includes("\n"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(JSON.parse(decoded.trim())).toEqual({ type: "phase", key: "a", fraction: 0.25 });

      finish();
      await pumped;
      expect(decoded.trim().split("\n").map((l) => JSON.parse(l).type)).toEqual(["phase", "phase", "result"]);
    });

    it("streams plain NDJSON to a request that does not accept gzip", async () => {
      const response = progressStreamResponse(async () => ({ ok: true }), { request: gzipRequest("identity") });
      expect(response.headers.get("Content-Encoding")).toBeNull();
      expect(await readLines(response)).toEqual([{ type: "result", result: { ok: true } }]);
    });

    it("ends a gzipped stream cleanly with an error line", async () => {
      const response = progressStreamResponse(async () => {
        throw new Error("boom");
      }, { request: gzipRequest() });
      const text = gunzipSync(Buffer.from(await response.arrayBuffer())).toString();
      expect(text).toBe('{"type":"error","message":"boom"}\n');
    });
  });
});
