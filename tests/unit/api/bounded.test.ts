import { describe, it, expect, vi, afterEach } from "vitest";
import { withTimeout } from "@/lib/api/bounded";

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves to the work's value when it finishes first", async () => {
    const onTimeout = vi.fn();
    await expect(withTimeout(Promise.resolve("done"), 1_000, onTimeout)).resolves.toBe("done");
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("resolves to null and reports it once the bound elapses", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const result = withTimeout(new Promise<string>(() => {}), 10_000, onTimeout);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBeNull();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("passes a rejection through", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1_000)).rejects.toThrow("boom");
  });

  it("clears its timer when the work settles", async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve(1), 10_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
