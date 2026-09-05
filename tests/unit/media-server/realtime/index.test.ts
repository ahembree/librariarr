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

describe("startRealtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No servers → the manager opens no real WebSockets during reconcile.
    h.appSettings.findFirst.mockResolvedValue({ realtimeSync: true });
    h.mediaServer.findMany.mockResolvedValue([]);
    _resetRealtimeForTesting();
  });
  afterEach(() => _resetRealtimeForTesting());

  it("is idempotent — repeated calls reuse the same manager", () => {
    startRealtime();
    const first = getRealtimeManager();
    startRealtime();
    expect(getRealtimeManager()).toBe(first);
  });

  it("reconciles on start and on server:changed", async () => {
    startRealtime();
    await vi.waitFor(() => expect(h.mediaServer.findMany).toHaveBeenCalledTimes(1));

    eventBus.emit({ type: "server:changed", userId: "u1" });
    await vi.waitFor(() => expect(h.mediaServer.findMany).toHaveBeenCalledTimes(2));
  });

  it("reconciles when the realtime toggle itself changes", async () => {
    startRealtime();
    await vi.waitFor(() => expect(h.mediaServer.findMany).toHaveBeenCalledTimes(1));

    eventBus.emit({ type: "settings:changed", userId: "u1", meta: { realtimeSync: false } });
    await vi.waitFor(() => expect(h.mediaServer.findMany).toHaveBeenCalledTimes(2));
  });

  it("ignores a settings:changed that has nothing to do with realtime", async () => {
    // `settings:changed` is general-purpose — the maintenance toggle emits it
    // too. Reconciling on all of them would re-read the DB and diff every
    // media-server socket every time an unrelated setting moved.
    startRealtime();
    await vi.waitFor(() => expect(h.mediaServer.findMany).toHaveBeenCalledTimes(1));

    eventBus.emit({ type: "settings:changed", userId: "u1", meta: { maintenanceMode: true } });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.mediaServer.findMany).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated app events", async () => {
    startRealtime();
    await vi.waitFor(() => expect(h.mediaServer.findMany).toHaveBeenCalledTimes(1));

    eventBus.emit({ type: "sync:completed", userId: "u1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.mediaServer.findMany).toHaveBeenCalledTimes(1);
  });
});
