import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  emit: vi.fn(),
}));

vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: h.emit } }));

import { emitSyncProgress, clearSyncProgressThrottle } from "@/lib/sync/sync-progress";

describe("emitSyncProgress", () => {
  beforeEach(() => {
    h.emit.mockClear();
    vi.useFakeTimers();
    // Distinct server ids per test would still share the module-level throttle
    // map across the file, so each test clears the ids it uses.
    clearSyncProgressThrottle("srv-1");
    clearSyncProgressThrottle("srv-2");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits sync:progress for the server on the first call", () => {
    emitSyncProgress("user-1", "srv-1");

    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledWith({
      type: "sync:progress",
      userId: "user-1",
      meta: { serverId: "srv-1" },
    });
  });

  it("carries no figures, so the status route stays the only place progress is computed", () => {
    emitSyncProgress("user-1", "srv-1");

    const meta = h.emit.mock.calls[0][0].meta as Record<string, unknown>;
    expect(Object.keys(meta)).toEqual(["serverId"]);
  });

  it("throttles repeat calls within the window to a single event", () => {
    // A sync commits a batch roughly every second; every event costs each open
    // tab a /api/sync/status query, so bursts must collapse.
    for (let i = 0; i < 10; i++) {
      emitSyncProgress("user-1", "srv-1");
      vi.advanceTimersByTime(100);
    }

    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it("emits again once the throttle window has elapsed", () => {
    emitSyncProgress("user-1", "srv-1");
    vi.advanceTimersByTime(2000);
    emitSyncProgress("user-1", "srv-1");

    expect(h.emit).toHaveBeenCalledTimes(2);
  });

  it("throttles per server, so a busy server cannot mute a quiet one", () => {
    emitSyncProgress("user-1", "srv-1");
    emitSyncProgress("user-1", "srv-2");

    expect(h.emit).toHaveBeenCalledTimes(2);
    expect(h.emit.mock.calls.map((c) => c[0].meta.serverId)).toEqual(["srv-1", "srv-2"]);
  });

  it("lets the next run report immediately after the throttle is cleared", () => {
    // Without clearing on sync end, a run starting just after another finished
    // would have its first batch swallowed by the previous run's window.
    emitSyncProgress("user-1", "srv-1");
    expect(h.emit).toHaveBeenCalledTimes(1);

    clearSyncProgressThrottle("srv-1");
    emitSyncProgress("user-1", "srv-1");

    expect(h.emit).toHaveBeenCalledTimes(2);
  });
});
