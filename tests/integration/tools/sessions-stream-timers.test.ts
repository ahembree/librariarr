import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute } from "../../setup/test-helpers";

// The stream's timers (poll, heartbeat, realtime throttle, lifetime cap) are
// driven with fake timers, so the DB is a stub here rather than the test DB.
const { findMany, getSessions } = vi.hoisted(() => ({
  findMany: vi.fn(),
  getSessions: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { mediaServer: { findMany } },
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn().mockImplementation(function () {
    return { getSessions };
  }),
}));

import { GET } from "@/app/api/tools/sessions/stream/route";
import { realtimeBus } from "@/lib/media-server/realtime/bus";
import { _resetFirstSeen } from "@/lib/media-server/session-first-seen";

// Captured before fake timers replace it: drain() needs a real macrotask turn.
const setImmediateReal = globalThis.setImmediate;

const SERVER = {
  id: "srv-1",
  name: "Plex",
  url: "http://plex.test:32400",
  accessToken: "tok",
  tlsSkipVerify: false,
  type: "PLEX",
};

function playing(sessionId: string, viewOffset = 0) {
  return {
    sessionId,
    player: { state: "playing", local: true },
    session: { bandwidth: 0, location: "lan" },
    viewOffset,
  };
}

function sessionEvent() {
  realtimeBus.emit({ kind: "session-changed", serverId: SERVER.id, serverType: "PLEX", at: Date.now() });
}

async function open() {
  const response = await callRoute(GET, { url: "/api/tools/sessions/stream" });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  // One outstanding read at a time, kept across drains so no chunk is lost to
  // a read that lost the race below.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  let finished = false;
  // Drain whatever is already queued without blocking on an empty stream.
  async function drain(): Promise<string> {
    while (!finished) {
      pending ??= reader.read();
      const next = await Promise.race([
        pending,
        new Promise<null>((r) => setImmediateReal(() => r(null))),
      ]);
      if (next === null) break;
      pending = null;
      if (next.done) {
        buffered += "<done>";
        finished = true;
        break;
      }
      buffered += decoder.decode(next.value);
    }
    const out = buffered;
    buffered = "";
    return out;
  }
  return { reader, drain };
}

describe("GET /api/tools/sessions/stream — timers and throttling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearMockSession();
    setMockSession({ userId: "user-1", isLoggedIn: true });
    findMany.mockReset().mockResolvedValue([SERVER]);
    getSessions.mockReset().mockResolvedValue([playing("s-1")]);
    // First-seen stamps are process-wide; start each stream from a clean map.
    _resetFirstSeen();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-sends on the 5s poll only when the sessions changed", async () => {
    const { reader, drain } = await open();
    expect(await drain()).toContain('"sessionId":"s-1"');

    await vi.advanceTimersByTimeAsync(5000);
    expect(getSessions).toHaveBeenCalledTimes(2);
    // Unchanged: nothing at all is written (the heartbeat is 30s away).
    expect(await drain()).toBe("");

    getSessions.mockResolvedValue([playing("s-1", 60_000)]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await drain()).toContain('"viewOffset":60000');

    await reader.cancel();
  });

  it("writes a heartbeat comment every 30 seconds", async () => {
    const { reader, drain } = await open();
    await drain();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await drain()).toContain(": heartbeat\n\n");
    await reader.cancel();
  });

  it("throttles realtime-driven polls to one per 2s with a single trailing poll", async () => {
    const { reader, drain } = await open();
    await drain();
    expect(getSessions).toHaveBeenCalledTimes(1);

    sessionEvent(); // leading edge: immediate poll
    await vi.advanceTimersByTimeAsync(0);
    expect(getSessions).toHaveBeenCalledTimes(2);

    // A burst inside the window collapses into ONE trailing poll.
    await vi.advanceTimersByTimeAsync(500);
    sessionEvent();
    sessionEvent();
    sessionEvent();
    await vi.advanceTimersByTimeAsync(0);
    expect(getSessions).toHaveBeenCalledTimes(2);

    getSessions.mockResolvedValue([playing("s-2")]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(getSessions).toHaveBeenCalledTimes(3);
    expect(await drain()).toContain('"sessionId":"s-2"');

    // Other realtime kinds never trigger a poll.
    await vi.advanceTimersByTimeAsync(2000);
    const before = getSessions.mock.calls.length;
    realtimeBus.emit({ kind: "watch-changed", serverId: SERVER.id, serverType: "PLEX", at: Date.now() } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(getSessions).toHaveBeenCalledTimes(before);

    await reader.cancel();
  });

  it("survives a failed session lookup and sends once the next poll succeeds", async () => {
    findMany.mockRejectedValueOnce(new Error("db down"));
    const { reader, drain } = await open();
    expect(await drain()).toBe("");

    await vi.advanceTimersByTimeAsync(5000);
    expect(await drain()).toContain('"sessionId":"s-1"');
    await reader.cancel();
  });

  it("stops polling and ignores realtime events after the client disconnects", async () => {
    const { reader, drain } = await open();
    await drain();
    await reader.cancel();
    const calls = getSessions.mock.calls.length;

    sessionEvent();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getSessions).toHaveBeenCalledTimes(calls);
  });

  it("closes the stream after its one-hour lifetime cap", async () => {
    const { drain } = await open();
    await drain();
    await vi.advanceTimersByTimeAsync(3_600_000 + 1000);
    expect(await drain()).toMatch(/<done>$/);

    const calls = getSessions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getSessions).toHaveBeenCalledTimes(calls);
  });

  it("closes the stream when a payload cannot be encoded", async () => {
    // A BigInt makes JSON.stringify throw inside send(), which marks the
    // stream closed rather than crashing the poll loop.
    getSessions.mockResolvedValue([{ ...playing("s-1"), weird: BigInt(1) }]);
    const { drain } = await open();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await drain()).toBe("<done>");
  });
});
