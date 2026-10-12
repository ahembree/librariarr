import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSyncStatus } from "@/lib/sync/sync-status-client";

describe("fetchSyncStatus", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ jobs: [{ id: "j1", status: "RUNNING", completedAt: null }] })));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shares one request between callers in the same task", async () => {
    const [a, b] = await Promise.all([fetchSyncStatus(), fetchSyncStatus()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/sync/status");
    expect(a).toEqual({ jobs: [{ id: "j1", status: "RUNNING", completedAt: null }] });
    expect(b).toBe(a);
  });

  it("starts a new request for a call in a later task", async () => {
    await fetchSyncStatus();
    vi.runOnlyPendingTimers();
    await fetchSyncStatus();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("answers null for an error status or a failed request", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect(await fetchSyncStatus()).toBeNull();
    vi.runOnlyPendingTimers();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchSyncStatus()).toBeNull();
  });
});
