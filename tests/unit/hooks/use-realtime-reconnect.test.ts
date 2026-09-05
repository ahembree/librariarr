import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Regression tests for the reconnect path in `useRealtime`.
 *
 * These cover the module-level connection machinery rather than the React hook,
 * because that is where the failure modes live. Both bugs below were introduced
 * by the auth probe: it turned a synchronous `onerror -> scheduleReconnect`
 * into one with an `await` in the middle, and an `await` is exactly long enough
 * for the shared source to be replaced underneath it.
 */

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>();

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.get(type)?.delete(fn);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** Simulate the server hard-closing the stream. */
  fireFatalError() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }

  fireOpen() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
}

const fetchMock = vi.fn();

describe("useRealtime reconnect machinery", () => {
  let mod: typeof import("@/hooks/use-realtime");

  beforeEach(async () => {
    vi.resetModules();
    FakeEventSource.instances = [];
    fetchMock.mockReset();
    // Default: the probe says the session is fine, so an error is an ordinary
    // dropped connection.
    fetchMock.mockResolvedValue({ status: 200 });

    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    mod = await import("@/hooks/use-realtime");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Drive the module the way the hook's effect does. */
  function subscribe() {
    return mod.__testing.acquireSource();
  }

  it("retires a dead source immediately, so the next subscriber never gets a closed stream", async () => {
    const first = subscribe();
    (first as unknown as FakeEventSource).fireOpen();

    (first as unknown as FakeEventSource).fireFatalError();

    // Before the probe resolves, a second subscriber arrives (a navigation).
    const second = subscribe();

    expect(second).not.toBe(first);
    expect((first as unknown as FakeEventSource).closed).toBe(true);
  });

  it("a late probe from a dead source does not close the healthy stream that replaced it", async () => {
    // The bug: `scheduleReconnect()` closes whatever `sharedSource` currently
    // is, without checking it is the source that actually failed. With an await
    // in front of it, a slow probe could kill a healthy reconnection.
    let resolveProbe!: (v: { status: number }) => void;
    fetchMock.mockReturnValue(new Promise((r) => { resolveProbe = r; }));

    const first = subscribe();
    (first as unknown as FakeEventSource).fireOpen();
    (first as unknown as FakeEventSource).fireFatalError();

    // A healthy replacement appears while the probe is still in flight.
    const second = subscribe();
    (second as unknown as FakeEventSource).fireOpen();
    expect((second as unknown as FakeEventSource).closed).toBe(false);

    // Now the stale probe finally answers.
    resolveProbe({ status: 200 });
    await vi.advanceTimersByTimeAsync(0);

    expect((second as unknown as FakeEventSource).closed).toBe(false);
  });

  it("keeps retrying after a 401, slowly, so a re-login recovers without a reload", async () => {
    fetchMock.mockResolvedValue({ status: 401 });

    const first = subscribe();
    (first as unknown as FakeEventSource).fireOpen();
    const createdBefore = FakeEventSource.instances.length;

    (first as unknown as FakeEventSource).fireFatalError();
    await vi.advanceTimersByTimeAsync(0);

    // Not on the ordinary 2s backoff — that would hammer a dead session.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeEventSource.instances.length).toBe(createdBefore);

    // But it does come back, on the slow floor.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(FakeEventSource.instances.length).toBeGreaterThan(createdBefore);
  });

  it("reconnects on the fast backoff for an ordinary drop", async () => {
    const first = subscribe();
    (first as unknown as FakeEventSource).fireOpen();
    const createdBefore = FakeEventSource.instances.length;

    (first as unknown as FakeEventSource).fireFatalError();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(FakeEventSource.instances.length).toBeGreaterThan(createdBefore);
  });

  it("a probe that never answers still reconnects, rather than stalling forever", async () => {
    // The probe is bounded by AbortSignal.timeout; a hung fetch that eventually
    // rejects must fall through to an ordinary reconnect.
    fetchMock.mockRejectedValue(new Error("timeout"));

    const first = subscribe();
    (first as unknown as FakeEventSource).fireOpen();
    const createdBefore = FakeEventSource.instances.length;

    (first as unknown as FakeEventSource).fireFatalError();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(FakeEventSource.instances.length).toBeGreaterThan(createdBefore);
  });

  it("does not fan out a resync burst on every reopen when a proxy flaps the connection", async () => {
    // A resync hits every mounted subscriber at once. Without a floor, a proxy
    // that closes SSE every few seconds would make each reopen a burst of tens
    // of requests — worse than the polling these pushes replaced.
    const resyncs: number[] = [];
    mod.__testing.registerResync(() => resyncs.push(1));

    const first = subscribe();
    (first as unknown as FakeEventSource).fireOpen(); // first open: no resync
    expect(resyncs).toHaveLength(0);

    (first as unknown as FakeEventSource).fireOpen(); // reopen: resync
    expect(resyncs).toHaveLength(1);

    (first as unknown as FakeEventSource).fireOpen(); // flap, within the floor
    (first as unknown as FakeEventSource).fireOpen();
    expect(resyncs).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_100);
    (first as unknown as FakeEventSource).fireOpen();
    expect(resyncs).toHaveLength(2);
  });

  it("holds the connection open across a navigation instead of rebuilding it", async () => {
    // The whole point of the grace period: a route change releases then
    // re-acquires, and must reuse the same connection.
    const first = subscribe();
    (first as unknown as FakeEventSource).fireOpen();

    mod.__testing.releaseSource(); // outgoing page unmounts
    const second = subscribe(); // incoming page mounts

    expect(second).toBe(first);
    expect((first as unknown as FakeEventSource).closed).toBe(false);
  });

  it("closes the connection once the grace period lapses with no subscriber", async () => {
    const first = subscribe();
    (first as unknown as FakeEventSource).fireOpen();

    mod.__testing.releaseSource();
    expect((first as unknown as FakeEventSource).closed).toBe(false);

    await vi.advanceTimersByTimeAsync(11_000);
    expect((first as unknown as FakeEventSource).closed).toBe(true);
  });
});
