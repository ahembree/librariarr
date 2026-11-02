// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { act, render } from "@testing-library/react";

const realtime = vi.hoisted(() => ({ handlers: new Map<string, () => void>(), live: false }));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (type: string, cb: () => void) => {
    realtime.handlers.set(type, cb);
    return { connected: realtime.live, authExpired: false };
  },
  isRealtimeLive: () => realtime.live,
  useRealtimeLive: () => realtime.live,
}));

// The fallback poll, run by hand.
const poll = vi.hoisted(() => ({ callback: null as (() => void) | null }));
vi.mock("@/hooks/use-fallback-poll", () => ({
  useFallbackPoll: (callback: () => void) => {
    poll.callback = callback;
  },
}));

const status = vi.hoisted(() => ({ queue: [] as unknown[] }));
vi.mock("@/lib/sync/sync-status-client", () => ({
  fetchSyncStatus: async () => status.queue.shift() ?? null,
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { SyncIndicator } from "@/components/sync-indicator";

const job = (status: string) => ({
  id: "j1",
  mediaServerId: "srv-1",
  status,
  startedAt: new Date().toISOString(),
  completedAt: status === "RUNNING" ? null : new Date().toISOString(),
  error: null,
  itemsProcessed: 5,
  totalItems: 10,
  currentLibrary: null,
  mediaServer: { name: "Plex", type: "PLEX" },
});
const running = { jobs: [job("RUNNING")] };
const done = { jobs: [job("COMPLETED")] };

async function check(run: () => void) {
  await act(async () => {
    run();
  });
}

beforeEach(() => {
  realtime.handlers.clear();
  realtime.live = false;
  status.queue = [];
  poll.callback = null;
});

describe("SyncIndicator", () => {
  it("reports every check that finds a sync running", async () => {
    realtime.live = true;
    status.queue = [running, running, running];
    const onSyncActive = vi.fn();
    render(createElement(SyncIndicator, { onSyncActive }));
    await act(async () => {});
    expect(onSyncActive).toHaveBeenCalledTimes(1);

    await check(() => realtime.handlers.get("sync:progress")!());
    await check(() => realtime.handlers.get("sync:progress")!());
    expect(onSyncActive).toHaveBeenCalledTimes(3);
  });

  it("leaves the end of a sync the stream announced to the page's own subscription", async () => {
    realtime.live = true;
    status.queue = [running, done];
    const onSyncComplete = vi.fn();
    render(createElement(SyncIndicator, { onSyncComplete }));
    await act(async () => {});

    await check(() => realtime.handlers.get("sync:completed")!());
    expect(onSyncComplete).not.toHaveBeenCalled();
  });

  it("goes by what triggered the check, not by the stream's state when it answers", async () => {
    // The event arrived, then the stream dropped before the check answered:
    // the page's subscription already saw the event.
    status.queue = [running, done];
    const onSyncComplete = vi.fn();
    render(createElement(SyncIndicator, { onSyncComplete }));
    await act(async () => {});

    await check(() => realtime.handlers.get("sync:completed")!());
    expect(onSyncComplete).not.toHaveBeenCalled();
  });

  it("reports the end of a sync only its own poll saw, the stream being down", async () => {
    status.queue = [running, done, done];
    const onSyncComplete = vi.fn();
    const onSyncActive = vi.fn();
    render(createElement(SyncIndicator, { onSyncComplete, onSyncActive }));
    await act(async () => {});

    await check(() => poll.callback!());
    expect(onSyncComplete).toHaveBeenCalledTimes(1);
    // An idle check after an idle one is no end.
    await check(() => poll.callback!());
    expect(onSyncComplete).toHaveBeenCalledTimes(1);
    expect(onSyncActive).toHaveBeenCalledTimes(1);
  });

  it("reports nothing while no sync runs", async () => {
    status.queue = [done, done];
    const onSyncComplete = vi.fn();
    const onSyncActive = vi.fn();
    render(createElement(SyncIndicator, { onSyncComplete, onSyncActive }));
    await act(async () => {});
    await check(() => poll.callback!());
    expect(onSyncComplete).not.toHaveBeenCalled();
    expect(onSyncActive).not.toHaveBeenCalled();
  });
});
