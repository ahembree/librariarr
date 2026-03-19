import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { withDeadlockRetry } from "@/lib/db-retry";

class PrismaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

describe("withDeadlockRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const result = await withDeadlockRetry("test", fn);
    expect(result).toBe("result");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on Prisma P2034 error code and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new PrismaError("P2034", "Transaction deadlock"))
      .mockResolvedValue("recovered");

    const promise = withDeadlockRetry("test-p2034", fn);
    await vi.advanceTimersByTimeAsync(100); // first retry delay: 100ms
    const result = await promise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 'deadlock detected' message", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("deadlock detected in some query"))
      .mockResolvedValue("recovered");

    const promise = withDeadlockRetry("test-msg", fn);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on P2010 with meta.code 40P01", async () => {
    const err = new PrismaError("P2010", "Raw query failed");
    (err as unknown as Record<string, unknown>).meta = { code: "40P01" };
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("recovered");

    const promise = withDeadlockRetry("test-p2010", fn);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws last error when max retries exceeded", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new PrismaError("P2034", "Deadlock 1"))
      .mockRejectedValueOnce(new PrismaError("P2034", "Deadlock 2"))
      .mockRejectedValueOnce(new PrismaError("P2034", "Deadlock 3"));

    let caughtError: Error | undefined;
    const promise = withDeadlockRetry("test-exceed", fn, 2).catch((e) => {
      caughtError = e;
    });

    // attempt 1 fails, retry after 100ms
    await vi.advanceTimersByTimeAsync(100);
    // attempt 2 fails, retry after 200ms
    await vi.advanceTimersByTimeAsync(200);
    // attempt 3 fails — exceeds maxRetries of 2, should throw

    await promise;
    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError!.message).toBe("Deadlock 3");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws non-deadlock errors immediately without retry", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new Error("unique constraint violation"));

    await expect(withDeadlockRetry("test-non-deadlock", fn)).rejects.toThrow(
      "unique constraint violation"
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws non-Prisma errors immediately without retry", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("cannot read property"));

    await expect(withDeadlockRetry("test-type-error", fn)).rejects.toThrow(
      "cannot read property"
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry for P2010 without 40P01 meta code", async () => {
    const err = new PrismaError("P2010", "Raw query failed");
    (err as unknown as Record<string, unknown>).meta = { code: "23505" };
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withDeadlockRetry("test-p2010-other", fn)).rejects.toThrow(
      "Raw query failed"
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("supports custom maxRetries", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new PrismaError("P2034", "Deadlock"))
      .mockResolvedValue("ok");

    const promise = withDeadlockRetry("test-custom", fn, 5);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("default maxRetries is 3 — fails 3 times, succeeds on 4th", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new PrismaError("P2034", "Deadlock 1"))
      .mockRejectedValueOnce(new PrismaError("P2034", "Deadlock 2"))
      .mockRejectedValueOnce(new PrismaError("P2034", "Deadlock 3"))
      .mockResolvedValue("finally");

    const promise = withDeadlockRetry("test-default-retries", fn);

    // attempt 1 fails, delay 100ms
    await vi.advanceTimersByTimeAsync(100);
    // attempt 2 fails, delay 200ms
    await vi.advanceTimersByTimeAsync(200);
    // attempt 3 fails, delay 400ms
    await vi.advanceTimersByTimeAsync(400);
    // attempt 4 succeeds

    const result = await promise;
    expect(result).toBe("finally");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("uses exponential backoff delays (100, 200, 400ms)", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    // Track setTimeout calls made during retries
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: TimerHandler,
      delay?: number
    ) => {
      if (delay && delay >= 100) {
        delays.push(delay);
      }
      return originalSetTimeout(fn, delay);
    }) as typeof setTimeout);

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new PrismaError("P2034", "Deadlock"))
      .mockRejectedValueOnce(new PrismaError("P2034", "Deadlock"))
      .mockRejectedValueOnce(new PrismaError("P2034", "Deadlock"))
      .mockResolvedValue("ok");

    const promise = withDeadlockRetry("test-backoff", fn);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);
    await promise;

    expect(delays).toEqual([100, 200, 400]);

    vi.restoreAllMocks();
  });

  it("does not retry for null error", async () => {
    const fn = vi.fn().mockRejectedValue(null);

    await expect(withDeadlockRetry("test-null", fn)).rejects.toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
