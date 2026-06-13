import { describe, it, expect } from "vitest";
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
    expect(events[2]).toMatchObject({ type: "phase", key: "b", fraction: 0.5 });
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
});
