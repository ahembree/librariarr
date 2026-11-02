import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  appSettings: { findFirst: vi.fn() },
  mediaServer: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: { appSettings: h.appSettings, mediaServer: h.mediaServer } }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { startRealtime, getRealtimeManager, _resetRealtimeForTesting } from "@/lib/media-server/realtime";
import { eventBus } from "@/lib/events/event-bus";

// `eventBus.emit` delivers synchronously, so whether an event asked for a
// reconcile is known the moment `emit` returns — no wait needed to prove a
// negative.
async function startAndSpyOnReconcile() {
  startRealtime();
  await vi.waitFor(() => expect(h.mediaServer.findMany).toHaveBeenCalledTimes(1));
  return vi.spyOn(getRealtimeManager(), "reconcile");
}

describe("startRealtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No servers → the manager opens no real WebSockets during reconcile.
    h.appSettings.findFirst.mockResolvedValue({ realtimeSync: true });
    h.mediaServer.findMany.mockResolvedValue([]);
    _resetRealtimeForTesting();
  });
  afterEach(() => _resetRealtimeForTesting());

  it("is idempotent — a repeated call starts nothing a second time", async () => {
    startRealtime();
    const reconcile = await startAndSpyOnReconcile();
    // One subscription: a server change reconciles once, not once per call.
    eventBus.emit({ type: "server:changed", userId: "u1" });
    expect(reconcile).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.mediaServer.findMany).toHaveBeenCalledTimes(2));
  });

  it("reconciles on start and on server:changed", async () => {
    const reconcile = await startAndSpyOnReconcile();

    eventBus.emit({ type: "server:changed", userId: "u1" });
    expect(reconcile).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.mediaServer.findMany).toHaveBeenCalledTimes(2));
  });

  it("reconciles when the realtime toggle itself changes", async () => {
    const reconcile = await startAndSpyOnReconcile();

    eventBus.emit({ type: "settings:changed", userId: "u1", meta: { realtimeSync: false } });
    expect(reconcile).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.mediaServer.findMany).toHaveBeenCalledTimes(2));
  });

  it("ignores a settings:changed that has nothing to do with realtime", async () => {
    // `settings:changed` is general-purpose — the maintenance toggle emits it
    // too. Reconciling on all of them would re-read the DB and diff every
    // media-server socket every time an unrelated setting moved.
    const reconcile = await startAndSpyOnReconcile();

    eventBus.emit({ type: "settings:changed", userId: "u1", meta: { maintenanceMode: true } });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("ignores unrelated app events", async () => {
    const reconcile = await startAndSpyOnReconcile();

    eventBus.emit({ type: "sync:completed", userId: "u1" });
    expect(reconcile).not.toHaveBeenCalled();
  });
});
