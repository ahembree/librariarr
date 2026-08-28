import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
} from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the media server factory - stream route uses createMediaServerClient
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn().mockImplementation(function () {
    return {
      getSessions: vi.fn().mockResolvedValue([]),
    };
  }),
}));

// Import route handler AFTER mocks
import { GET } from "@/app/api/tools/sessions/stream/route";
import { createMediaServerClient } from "@/lib/media-server/factory";
// Same singleton the route subscribes to (bus.ts is one module regardless of import path).
import { realtimeBus } from "@/lib/media-server/realtime/bus";

describe("GET /api/tools/sessions/stream", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, {
      url: "/api/tools/sessions/stream",
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns correct content-type header (text/event-stream)", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/tools/sessions/stream",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");

    // Cancel the stream to clean up
    if (response.body) {
      await response.body.cancel();
    }
  });

  it("returns a readable stream", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/tools/sessions/stream",
    });

    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();
    expect(response.body).toBeInstanceOf(ReadableStream);

    // Read the initial data from the stream
    const reader = response.body!.getReader();
    const { value, done } = await reader.read();

    // Should receive an initial SSE event (sessions data)
    expect(done).toBe(false);
    expect(value).toBeDefined();

    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: sessions");
    expect(text).toContain("data:");

    // Cancel the reader to clean up
    await reader.cancel();
  });

  it("pushes an update when a realtime session event fires", async () => {
    const user = await createTestUser();
    await createTestServer(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    // First poll: no sessions. After the realtime event: one active session.
    const getSessions = vi.fn().mockResolvedValue([]);
    vi.mocked(createMediaServerClient).mockImplementation(function () {
      return { getSessions } as never;
    });

    const response = await callRoute(GET, { url: "/api/tools/sessions/stream" });
    const reader = response.body!.getReader();

    // Consume the initial (empty) sessions event.
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: sessions");

    // A stream starts on the server; a realtime event drives an immediate re-poll.
    getSessions.mockResolvedValue([
      { sessionId: "rt-1", player: { state: "playing", local: true }, session: { bandwidth: 0, location: "lan" } },
    ]);
    realtimeBus.emit({ kind: "session-changed", serverId: "x", serverType: "PLEX", at: Date.now() });

    let text = "";
    for (let i = 0; i < 3; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      if (text.includes("rt-1")) break;
    }
    expect(text).toContain("rt-1");

    await reader.cancel();
  });

  it("keeps a session's start time when a server poll fails and recovers", async () => {
    const user = await createTestUser();
    await createTestServer(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    // Fail exactly one poll. Flipping a flag on a timer races the route's own
    // DB round-trip, so arm it by call instead.
    let failNextPoll = false;
    const getSessions = vi.fn(() => {
      if (failNextPoll) {
        failNextPoll = false;
        return Promise.reject(new Error("server unreachable"));
      }
      return Promise.resolve([
        {
          sessionId: "flaky-1",
          player: { state: "playing", local: true },
          session: { bandwidth: 0, location: "lan" },
        },
      ]);
    });
    vi.mocked(createMediaServerClient).mockImplementation(function () {
      return { getSessions } as never;
    });

    const response = await callRoute(GET, { url: "/api/tools/sessions/stream" });
    const reader = response.body!.getReader();

    /** All `event: sessions` payloads seen so far. */
    const framesFor = (text: string) =>
      text
        .split("\n\n")
        .filter((f) => f.startsWith("event: sessions"))
        .map(
          (f) =>
            JSON.parse(f.slice(f.indexOf("data: ") + 6)) as {
              sessions: Array<{ sessionId: string; startedAt: number }>;
            }
        );

    let text = new TextDecoder().decode((await reader.read()).value);
    const initial = framesFor(text)[0].sessions.find((s) => s.sessionId === "flaky-1");
    expect(initial?.startedAt).toBeGreaterThan(0);

    // The server drops out for one poll, then comes back.
    failNextPoll = true;
    realtimeBus.emit({ kind: "session-changed", serverId: "x", serverType: "PLEX", at: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    // Second event lands inside the realtime throttle, so this poll is the
    // trailing one ~2s later — by then the server is answering again.
    realtimeBus.emit({ kind: "session-changed", serverId: "x", serverType: "PLEX", at: Date.now() });

    let recovered: { sessionId: string; startedAt: number } | undefined;
    for (let i = 0; i < 8; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      const withSession = framesFor(text).filter((f) =>
        f.sessions.some((s) => s.sessionId === "flaky-1")
      );
      if (withSession.length > 1) {
        recovered = withSession[withSession.length - 1].sessions.find(
          (s) => s.sessionId === "flaky-1"
        );
        break;
      }
    }

    // Regression: the failed poll used to prune sessionFirstSeen, so the
    // stream's displayed duration restarted from zero once the server
    // answered again.
    expect(recovered).toBeDefined();
    expect(recovered!.startedAt).toBe(initial!.startedAt);

    await reader.cancel();
  });

  it("pushes an update when only the audio transcode decision changes", async () => {
    const user = await createTestUser();
    await createTestServer(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    // Paused, so neither player state nor viewOffset moves — the audio
    // decision is the only thing that changes.
    let audioDecision = "transcode";
    const getSessions = vi.fn(() =>
      Promise.resolve([
        {
          sessionId: "audio-1",
          player: { state: "paused", local: true },
          session: { bandwidth: 0, location: "lan" },
          viewOffset: 12345,
          transcoding: { videoDecision: "copy", audioDecision },
        },
      ])
    );
    vi.mocked(createMediaServerClient).mockImplementation(function () {
      return { getSessions } as never;
    });

    const response = await callRoute(GET, { url: "/api/tools/sessions/stream" });
    const reader = response.body!.getReader();

    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"audioDecision":"transcode"');

    // The client renegotiates to direct audio; nothing else about the session
    // changes. Regression: audioDecision was absent from the change
    // fingerprint, so this update never reached the browser.
    audioDecision = "copy";
    realtimeBus.emit({ kind: "session-changed", serverId: "x", serverType: "PLEX", at: Date.now() });

    let text = "";
    for (let i = 0; i < 4; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      if (text.includes('"audioDecision":"copy"')) break;
    }
    expect(text).toContain('"audioDecision":"copy"');

    await reader.cancel();
  });
});
