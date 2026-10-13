import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSyncStatus } from "@/lib/sync/sync-status-client";

describe("fetchSyncStatus", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ jobs: [{ id: "j1", status: "RUNNING", completedAt: null }] })));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shares one request between callers in the same synchronous turn", async () => {
    const [a, b] = await Promise.all([fetchSyncStatus(), fetchSyncStatus()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/sync/status");
    expect(a).toEqual({ jobs: [{ id: "j1", status: "RUNNING", completedAt: null }] });
    expect(b).toBe(a);
  });

  it("starts a new request for any later call, even before the first has answered", async () => {
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { release = () => resolve(new Response(JSON.stringify({ jobs: [] }))); }),
    );
    const first = fetchSyncStatus();
    // A later turn — the next event's listener — while the first is in flight.
    await Promise.resolve();
    const second = fetchSyncStatus();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    release();
    await Promise.all([first, second]);
  });

  it("answers null for an error status or a failed request", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect(await fetchSyncStatus()).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchSyncStatus()).toBeNull();
  });
});
