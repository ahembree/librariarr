/**
 * POST /api/media/history/sync — the History page's Refresh button.
 *
 * The route streams NDJSON progress (`progressStreamResponse`) instead of
 * returning a single JSON blob, because a first Tracearr import pulls a whole
 * server history and used to sit behind an indefinite spinner. The contract
 * this test pins down:
 *
 *  - Auth, validation and the ownership check happen BEFORE the stream opens,
 *    so they still carry real 401/400/404 statuses. Once streaming starts the
 *    status is committed to 200 and failures are in-band.
 *  - One phase per server (`key` = server id, `label` = server name).
 *  - `fraction` is forwarded verbatim — present for the determinate native
 *    path, ABSENT for Tracearr's keyset-paginated import, which has no total
 *    and must render as an honest indeterminate bar.
 *  - The terminal result keeps the pre-streaming payload shape,
 *    `{ success: true, counts }`, with -1 for a server whose sync threw.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  expectStreamResult,
  createTestUser,
  createTestServer,
} from "../../setup/test-helpers";
import type { WatchHistoryProgressReporter } from "@/lib/sync/watch-history-progress";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The sync engine itself is exercised by its own tests; here it is a stub we
// drive so the route's progress plumbing can be observed deterministically.
const { mockSyncWatchHistory } = vi.hoisted(() => ({
  mockSyncWatchHistory: vi.fn(),
}));

vi.mock("@/lib/sync/sync-watch-history", () => ({
  syncWatchHistory: mockSyncWatchHistory,
}));

import { POST } from "@/app/api/media/history/sync/route";

/** Progress event as it arrives on the wire (a missing `fraction` stays missing). */
type PhaseEvent = {
  type: "phase";
  key: string;
  fraction?: number;
  detail?: string;
};
type PlanEvent = {
  type: "plan";
  phases: { key: string; label: string }[];
};

const phaseEvents = (events: Array<Record<string, unknown>>) =>
  events.filter((e) => e.type === "phase") as PhaseEvent[];

const planEvent = (events: Array<Record<string, unknown>>) =>
  events.find((e) => e.type === "plan") as PlanEvent | undefined;

/** The terminal payload the History page reads. */
type SyncResult = {
  success: boolean;
  counts: Record<string, number>;
  cancelled: boolean;
};

/**
 * A POST whose request signal the test controls.
 *
 * `callRoute` builds its request internally, so cancellation — the one thing a
 * 160k-play Tracearr import most needs — can only be driven by constructing the
 * request here. `signal` is a documented member of Next's `RequestInit`.
 */
function abortableRequest(signal: AbortSignal, body: unknown = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/media/history/sync", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    signal,
  });
}

describe("POST /api/media/history/sync", () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    mockSyncWatchHistory.mockReset();
    // Default: a silent sync that reports no progress at all.
    mockSyncWatchHistory.mockResolvedValue({ count: 0 });

    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true, plexToken: "token" });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    clearMockSession();
    const response = await callRoute(POST, { method: "POST", body: {} });
    expect(response.status).toBe(401);
    expect(mockSyncWatchHistory).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid body", async () => {
    // Validation runs before the stream opens, so this is a real 400 with JSON
    // details rather than an in-band error event on a 200 stream.
    const response = await callRoute(POST, {
      method: "POST",
      body: { serverId: 123 },
    });
    const data = await expectJson<{ error: string }>(response, 400);
    expect(data.error).toBe("Validation failed");
    expect(mockSyncWatchHistory).not.toHaveBeenCalled();
  });

  it("returns 404 for a server owned by another user", async () => {
    const otherUser = await createTestUser({
      username: "other",
      email: "other@example.com",
    });
    const otherServer = await createTestServer(otherUser.id, { name: "Theirs" });

    const response = await callRoute(POST, {
      method: "POST",
      body: { serverId: otherServer.id },
    });
    await expectJson<{ error: string }>(response, 404);
    expect(mockSyncWatchHistory).not.toHaveBeenCalled();
  });

  it("streams a plan, phase events and a result for a single server", async () => {
    const server = await createTestServer(userId, { name: "Plex Main" });

    mockSyncWatchHistory.mockImplementation(
      async (_serverId: string, onProgress?: WatchHistoryProgressReporter) => {
        onProgress?.({ imported: 120, pages: 2, detail: "120 plays" });
        return { count: 120 };
      },
    );

    const response = await callRoute(POST, {
      method: "POST",
      body: { serverId: server.id },
    });
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");

    const { result, events } = await expectStreamResult<SyncResult>(response);

    // The plan names the server so the bar can label its one segment.
    expect(planEvent(events)?.phases).toEqual([
      { key: server.id, label: "Plex Main" },
    ]);

    const phases = phaseEvents(events);
    expect(phases.length).toBeGreaterThan(0);
    expect(phases.every((p) => p.key === server.id)).toBe(true);
    expect(phases.some((p) => p.detail === "120 plays")).toBe(true);

    expect(result).toEqual({
      success: true,
      counts: { [server.id]: 120 },
      cancelled: false,
    });
  });

  it("emits one phase per enabled server when no serverId is given", async () => {
    const alpha = await createTestServer(userId, { name: "Alpha" });
    const bravo = await createTestServer(userId, { name: "Bravo" });
    const disabled = await createTestServer(userId, {
      name: "Charlie",
      enabled: false,
    });

    mockSyncWatchHistory.mockImplementation(async (serverId: string) => ({
      count: serverId === alpha.id ? 10 : 20,
    }));

    const { result, events } = await expectStreamResult<SyncResult>(
      await callRoute(POST, { method: "POST", body: {} }),
    );

    // Ordered by name, and the disabled server is neither planned nor synced.
    expect(planEvent(events)?.phases).toEqual([
      { key: alpha.id, label: "Alpha" },
      { key: bravo.id, label: "Bravo" },
    ]);
    expect(phaseEvents(events).map((p) => p.key)).toContain(bravo.id);
    expect(result.counts).toEqual({ [alpha.id]: 10, [bravo.id]: 20 });
    expect(result.counts[disabled.id]).toBeUndefined();
  });

  it("records -1 for a server whose sync throws and still completes the others", async () => {
    const good = await createTestServer(userId, { name: "Alpha" });
    const bad = await createTestServer(userId, { name: "Bravo" });

    mockSyncWatchHistory.mockImplementation(async (serverId: string) => {
      if (serverId === bad.id) throw new Error("connect ECONNREFUSED");
      return { count: 7 };
    });

    const { result, events } = await expectStreamResult<SyncResult>(
      await callRoute(POST, { method: "POST", body: {} }),
    );

    // The failure is per-server, not per-request: the stream still terminates
    // with a result and every server appears in `counts`.
    expect(result).toEqual({
      success: true,
      counts: { [good.id]: 7, [bad.id]: -1 },
      cancelled: false,
    });
    // The failing server still got its phase, so the bar advanced past it.
    expect(phaseEvents(events).map((p) => p.key)).toContain(bad.id);
  });

  it("forwards fraction when the sync reports one and omits it when it does not", async () => {
    const server = await createTestServer(userId, { name: "Plex Main" });

    mockSyncWatchHistory.mockImplementation(
      async (_serverId: string, onProgress?: WatchHistoryProgressReporter) => {
        // Tracearr shape: a live count, no total, therefore no fraction.
        onProgress?.({ imported: 500, pages: 5, detail: "500 plays" });
        // Native shape: a real i / total.
        onProgress?.({ imported: 50, fraction: 0.5, detail: "50 / 100 plays" });
        return { count: 550 };
      },
    );

    const { events } = await expectStreamResult(
      await callRoute(POST, { method: "POST", body: { serverId: server.id } }),
    );

    const phases = phaseEvents(events);

    const indeterminate = phases.find((p) => p.detail === "500 plays");
    // Must be genuinely ABSENT, not 0 — the UI picks its bar mode on
    // `fraction !== undefined`, so a coerced 0 would render a determinate bar
    // frozen at 0% for the whole Tracearr import.
    expect(indeterminate).toBeDefined();
    expect(indeterminate).not.toHaveProperty("fraction");

    const determinate = phases.find((p) => p.detail === "50 / 100 plays");
    expect(determinate?.fraction).toBe(0.5);
  });

  describe("cancellation", () => {
    it("reports cancelled: false for a run that finished on its own", async () => {
      const server = await createTestServer(userId, { name: "Plex Main" });
      mockSyncWatchHistory.mockResolvedValue({ count: 4 });

      const { result } = await expectStreamResult<SyncResult>(
        await callRoute(POST, { method: "POST", body: { serverId: server.id } }),
      );

      // The History page uses this to decide between "history is up to date"
      // and "run Refresh again to continue" — so a completed run must not be
      // reported as cut short.
      expect(result).toEqual({
        success: true,
        counts: { [server.id]: 4 },
        cancelled: false,
      });
    });

    it("ends with a well-formed result, not an error, when the request is already aborted", async () => {
      await createTestServer(userId, { name: "Plex Main" });

      const controller = new AbortController();
      controller.abort();

      // `expectStreamResult` throws on an `error` event and on a stream with no
      // terminal `result`, so simply getting here proves the abort produced
      // neither a hang nor an in-band failure. The status is already committed
      // to 200 by the first NDJSON byte, so an error line is the only way this
      // could go wrong — and a client that hung up still deserves a clean,
      // parseable close rather than a half-written stream.
      const { result, events } = await expectStreamResult<SyncResult>(
        await POST(abortableRequest(controller.signal)),
      );

      expect(result).toEqual({ success: true, counts: {}, cancelled: true });
      // The plan was still emitted — the stream is well-formed, just empty.
      expect(planEvent(events)?.phases).toHaveLength(1);
      // Nothing was started for a client that had already gone.
      expect(mockSyncWatchHistory).not.toHaveBeenCalled();
    });

    it("hands the live abort signal to syncWatchHistory as its third argument", async () => {
      const server = await createTestServer(userId, { name: "Plex Main" });
      const controller = new AbortController();
      let received: AbortSignal | undefined;

      mockSyncWatchHistory.mockImplementation(
        async (
          _serverId: string,
          _onProgress?: WatchHistoryProgressReporter,
          signal?: AbortSignal,
        ) => {
          received = signal;
          // The user hits Stop (or closes the tab) mid-server.
          controller.abort();
          return { count: 3 };
        },
      );

      const { result } = await expectStreamResult<SyncResult>(
        await POST(abortableRequest(controller.signal, { serverId: server.id })),
      );

      // The route's own `signal.aborted` check only runs BETWEEN servers, so
      // without this argument a 160k-play import would keep paging for minutes
      // after the user stopped it — the reported "I cannot stop a sync once the
      // Tracearr sync starts". It must also be the LIVE signal, not a detached
      // copy: aborting the request has to flip the one the importer is holding.
      expect(received).toBeInstanceOf(AbortSignal);
      expect(received?.aborted).toBe(true);

      // The work that did land is still reported, flagged as cut short.
      expect(result).toEqual({
        success: true,
        counts: { [server.id]: 3 },
        cancelled: true,
      });
    });
  });
});
