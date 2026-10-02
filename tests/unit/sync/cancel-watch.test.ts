import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { watchForCancel, CANCEL_POLL_MS } from "@/lib/sync/cancel-watch";

describe("watchForCancel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts once the flag reads true, and not before", async () => {
    let flag = false;
    const watch = watchForCancel(async () => flag);

    await vi.advanceTimersByTimeAsync(CANCEL_POLL_MS * 3);
    expect(watch.signal.aborted).toBe(false);

    flag = true;
    await vi.advanceTimersByTimeAsync(CANCEL_POLL_MS);
    expect(watch.signal.aborted).toBe(true);
    watch.stop();
  });

  it("stops checking after stop()", async () => {
    const isCancelled = vi.fn(async () => false);
    const watch = watchForCancel(isCancelled);

    await vi.advanceTimersByTimeAsync(CANCEL_POLL_MS);
    expect(isCancelled).toHaveBeenCalledTimes(1);

    watch.stop();
    await vi.advanceTimersByTimeAsync(CANCEL_POLL_MS * 5);
    expect(isCancelled).toHaveBeenCalledTimes(1);
  });

  it("treats a failed check as not cancelled and tries again", async () => {
    // A transient DB error must not read as a Stop.
    const isCancelled = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(true);
    const watch = watchForCancel(isCancelled);

    await vi.advanceTimersByTimeAsync(CANCEL_POLL_MS);
    expect(watch.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(CANCEL_POLL_MS);
    expect(watch.signal.aborted).toBe(true);
    watch.stop();
  });

  it("never overlaps checks while one is still in flight", async () => {
    let resolveCheck: (value: boolean) => void = () => {};
    const isCancelled = vi.fn(
      () => new Promise<boolean>((resolve) => { resolveCheck = resolve; }),
    );
    const watch = watchForCancel(isCancelled);

    // A slow database: several ticks pass while the first check is pending.
    await vi.advanceTimersByTimeAsync(CANCEL_POLL_MS * 4);
    expect(isCancelled).toHaveBeenCalledTimes(1);

    resolveCheck(false);
    await vi.advanceTimersByTimeAsync(CANCEL_POLL_MS);
    expect(isCancelled).toHaveBeenCalledTimes(2);
    watch.stop();
  });

  it("stops checking once aborted", async () => {
    const isCancelled = vi.fn(async () => true);
    const watch = watchForCancel(isCancelled);

    await vi.advanceTimersByTimeAsync(CANCEL_POLL_MS * 5);
    expect(watch.signal.aborted).toBe(true);
    expect(isCancelled).toHaveBeenCalledTimes(1);
    watch.stop();
  });
});
