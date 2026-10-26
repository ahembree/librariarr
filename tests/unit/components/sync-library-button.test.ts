// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

const realtime = vi.hoisted(() => ({ handlers: new Map<string, () => void>(), live: false }));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (type: string, cb: () => void) => {
    realtime.handlers.set(type, cb);
    return { connected: realtime.live, authExpired: false };
  },
  isRealtimeLive: () => realtime.live,
  useRealtimeLive: () => realtime.live,
}));

import { SyncLibraryButton } from "@/components/sync-library-button";

const fetchMock = vi.fn();
let statusQueue: unknown[];
const statusCalls = () => fetchMock.mock.calls.filter(([url]) => url === "/api/sync/status").length;

function json(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body });
}

const running = (processed: number, total: number) => ({
  jobs: [{ id: "j1", status: "RUNNING", itemsProcessed: processed, totalItems: total, completedAt: null }],
});
const done = { jobs: [{ id: "j1", status: "COMPLETED", itemsProcessed: 10, totalItems: 10, completedAt: "x" }] };

beforeEach(() => {
  realtime.handlers.clear();
  realtime.live = false;
  statusQueue = [];
  fetchMock.mockReset().mockImplementation((url: string) => {
    if (url === "/api/sync/by-type") return json({ syncedCount: 1 });
    if (url === "/api/sync/status") return json(statusQueue.shift() ?? done);
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function clickSync() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button"));
  });
}

describe("SyncLibraryButton", () => {
  it("checks the run at once, then follows sync events, with no poll while pushes arrive", async () => {
    vi.useFakeTimers();
    realtime.live = true;
    statusQueue = [running(0, 10), running(5, 10), done];
    const onSyncComplete = vi.fn();
    render(createElement(SyncLibraryButton, { libraryType: "MOVIE", onSyncComplete }));
    await clickSync();
    expect(fetchMock).toHaveBeenCalledWith("/api/sync/by-type", expect.objectContaining({ method: "POST" }));
    expect(statusCalls()).toBe(1);
    expect(screen.getByRole("button").textContent).toContain("0%");

    // No timer-driven checks while the stream delivers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(statusCalls()).toBe(1);

    await act(async () => realtime.handlers.get("sync:progress")!());
    expect(screen.getByRole("button").textContent).toContain("50%");

    await act(async () => realtime.handlers.get("sync:completed")!());
    expect(screen.getByRole("button").textContent).toBe("Sync");
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
    // The page refetches on the same `sync:completed` itself.
    expect(onSyncComplete).not.toHaveBeenCalled();
  });

  it("falls back to a poll while pushes are not arriving, and tells the page when it ends", async () => {
    vi.useFakeTimers();
    statusQueue = [running(1, 10), running(4, 10), done];
    const onSyncComplete = vi.fn();
    render(createElement(SyncLibraryButton, { libraryType: "SERIES", onSyncComplete }));
    await clickSync();
    expect(statusCalls()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(statusCalls()).toBe(2);
    expect(screen.getByRole("button").textContent).toContain("40%");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(statusCalls()).toBe(3);
    expect(onSyncComplete).toHaveBeenCalledTimes(1);
    // Done: no more checks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(statusCalls()).toBe(3);
  });

  it("ignores sync events while it has not started a sync", async () => {
    render(createElement(SyncLibraryButton, { libraryType: "MUSIC" }));
    await act(async () => realtime.handlers.get("sync:progress")!());
    expect(statusCalls()).toBe(0);
  });

  it("stops at once when the route queued nothing, and keeps the bar on a failed check", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/sync/by-type") return json({ syncedCount: 0 });
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    render(createElement(SyncLibraryButton, { libraryType: "MOVIE" }));
    await clickSync();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
    expect(statusCalls()).toBe(0);

    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/sync/by-type") return json({ syncedCount: 1 });
      return Promise.resolve({ ok: false, json: async () => ({}) });
    });
    await clickSync();
    // A refused check says nothing about the run: still syncing.
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
