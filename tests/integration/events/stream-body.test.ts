import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setMockSession, clearMockSession } from "../../setup/mock-session";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/events/stream/route";
import { eventBus } from "@/lib/events/event-bus";

const decoder = new TextDecoder();

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string | null> {
  const { value, done } = await reader.read();
  return done ? null : decoder.decode(value);
}

function parseEvents(text: string) {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event: "))
    .map((block) => {
      const [eventLine, dataLine] = block.split("\n");
      return { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) };
    });
}

describe("GET /api/events/stream — the SSE body", () => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  beforeEach(() => {
    clearMockSession();
  });

  afterEach(async () => {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader = null;
    }
    vi.useRealTimers();
  });

  it("answers 401 JSON for a signed-out caller and subscribes nothing", async () => {
    const before = eventBus.listenerCount;
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(eventBus.listenerCount).toBe(before);
  });

  it("opens an event stream that starts with a connected event", async () => {
    setMockSession({ userId: "user-1", isLoggedIn: true });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");

    reader = res.body!.getReader();
    const [connected] = parseEvents((await readChunk(reader))!);
    expect(connected.event).toBe("connected");
    expect(typeof connected.data.timestamp).toBe("number");
  });

  it("forwards only the session user's events, with their meta", async () => {
    setMockSession({ userId: "user-1", isLoggedIn: true });
    const res = await GET();
    reader = res.body!.getReader();
    await readChunk(reader); // connected

    eventBus.emit({ type: "sync:completed", userId: "someone-else", meta: { serverId: "theirs" } });
    eventBus.emit({ type: "sync:progress", userId: "user-1", meta: { serverId: "srv-1" } });

    const [event, ...rest] = parseEvents((await readChunk(reader))!);
    expect(rest).toEqual([]);
    expect(event.event).toBe("sync:progress");
    expect(event.data).toEqual({ timestamp: expect.any(Number), serverId: "srv-1" });

    // An event without meta still carries its timestamp.
    eventBus.emit({ type: "server:changed", userId: "user-1" });
    const [changed] = parseEvents((await readChunk(reader))!);
    expect(changed).toEqual({ event: "server:changed", data: { timestamp: expect.any(Number) } });
  });

  it("unsubscribes from the bus as soon as the client disconnects", async () => {
    setMockSession({ userId: "user-1", isLoggedIn: true });
    const before = eventBus.listenerCount;
    const res = await GET();
    const r = res.body!.getReader();
    await readChunk(r);
    expect(eventBus.listenerCount).toBe(before + 1);

    await r.cancel();
    expect(eventBus.listenerCount).toBe(before);
    // Emitting after disconnect does not throw.
    expect(() => eventBus.emit({ type: "sync:completed", userId: "user-1" })).not.toThrow();
  });

  it("sends a heartbeat comment every 15 seconds and ends the stream after an hour", async () => {
    vi.useFakeTimers();
    setMockSession({ userId: "user-1", isLoggedIn: true });
    const before = eventBus.listenerCount;
    const res = await GET();
    const r = res.body!.getReader();
    await readChunk(r); // connected

    vi.advanceTimersByTime(15_000);
    expect(await readChunk(r)).toBe(": heartbeat\n\n");

    vi.advanceTimersByTime(3_600_000);
    // Heartbeats queued before the lifetime cap fired — one every 15s from the
    // 30s mark through the hour mark itself — then the stream closes.
    let chunk: string | null;
    let heartbeats = 0;
    while ((chunk = await readChunk(r)) !== null) {
      expect(chunk).toBe(": heartbeat\n\n");
      heartbeats++;
    }
    expect(heartbeats).toBe(239);
    expect(eventBus.listenerCount).toBe(before);

    // Nothing is sent once the stream has been torn down.
    eventBus.emit({ type: "sync:completed", userId: "user-1" });
    vi.advanceTimersByTime(60_000);
    expect(eventBus.listenerCount).toBe(before);
  });
});
