import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from "axios";
import { configureRetry } from "@/lib/http-retry";

/**
 * Creates a minimal mock AxiosInstance with an interceptors registry.
 * When configureRetry registers a response error handler, we capture it
 * so tests can invoke it directly.
 */
function createMockAxios() {
  let errorHandler: ((error: AxiosError) => Promise<unknown>) | undefined;

  const instance = {
    interceptors: {
      response: {
        use: (_onFulfilled: unknown, onRejected: (error: AxiosError) => Promise<unknown>) => {
          errorHandler = onRejected;
        },
      },
    },
    request: vi.fn(),
  } as unknown as AxiosInstance;

  return {
    instance,
    /** Invoke the registered error interceptor */
    triggerError: (error: AxiosError) => {
      if (!errorHandler) throw new Error("No error handler registered");
      return errorHandler(error);
    },
    /** Access the mock for instance.request() */
    get requestMock() {
      return instance.request as ReturnType<typeof vi.fn>;
    },
  };
}

function makeAxiosError(
  overrides: {
    code?: string;
    message?: string;
    response?: { status: number };
    method?: string;
  } = {},
): AxiosError {
  const error = new Error(overrides.message ?? "request failed") as AxiosError;
  error.code = overrides.code;
  error.isAxiosError = true;
  error.config = {
    method: overrides.method ?? "get",
  } as InternalAxiosRequestConfig;
  error.response = overrides.response
    ? ({ status: overrides.response.status } as AxiosError["response"])
    : undefined;
  error.toJSON = () => ({});
  return error;
}

describe("configureRetry", () => {
  let mockAxios: ReturnType<typeof createMockAxios>;
  let log: { warn: (prefix: string, msg: string) => void };

  beforeEach(() => {
    vi.useFakeTimers();
    mockAxios = createMockAxios();
    log = { warn: vi.fn() as unknown as (prefix: string, msg: string) => void };
    configureRetry(mockAxios.instance, "TestPrefix", log);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Retryable network errors ──────────────────────────────────────

  describe("retryable network errors (no response)", () => {
    const retryableCodes = [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNABORTED",
      "EPIPE",
      "EPROTO",
      "EAI_AGAIN",
    ];

    for (const code of retryableCodes) {
      it(`retries on ${code} network error`, async () => {
        const error = makeAxiosError({ code });
        mockAxios.requestMock.mockResolvedValue({ data: "ok" });

        const promise = mockAxios.triggerError(error);
        await vi.advanceTimersByTimeAsync(1000); // 1s delay for attempt 1
        const result = await promise;

        expect(result).toEqual({ data: "ok" });
        expect(mockAxios.requestMock).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledWith(
          "TestPrefix",
          expect.stringContaining(`attempt 1/3`),
        );
      });
    }
  });

  // ── SSL/TLS errors ────────────────────────────────────────────────

  describe("retryable SSL/TLS errors", () => {
    const sslMessages = [
      "decryption failed or bad record mac",
      "bad record mac",
      "ssl3_get_record:wrong version number",
    ];

    for (const message of sslMessages) {
      it(`retries on SSL error: "${message}"`, async () => {
        const error = makeAxiosError({ message });
        mockAxios.requestMock.mockResolvedValue({ data: "recovered" });

        const promise = mockAxios.triggerError(error);
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result).toEqual({ data: "recovered" });
        expect(mockAxios.requestMock).toHaveBeenCalledTimes(1);
      });
    }
  });

  // ── Server errors (5xx) ───────────────────────────────────────────

  describe("retryable server errors on idempotent methods", () => {
    const retryableStatuses = [502, 503, 504];

    for (const status of retryableStatuses) {
      it(`retries ${status} on GET request`, async () => {
        const error = makeAxiosError({
          response: { status },
          method: "get",
        });
        mockAxios.requestMock.mockResolvedValue({ data: "success" });

        const promise = mockAxios.triggerError(error);
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result).toEqual({ data: "success" });
        expect(mockAxios.requestMock).toHaveBeenCalledTimes(1);
      });

      it(`retries ${status} on HEAD request`, async () => {
        const error = makeAxiosError({
          response: { status },
          method: "head",
        });
        mockAxios.requestMock.mockResolvedValue({ data: "success" });

        const promise = mockAxios.triggerError(error);
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result).toEqual({ data: "success" });
        expect(mockAxios.requestMock).toHaveBeenCalledTimes(1);
      });
    }
  });

  // ── Non-retryable errors ──────────────────────────────────────────

  describe("non-retryable errors throw immediately", () => {
    it("does not retry on 500 Internal Server Error", async () => {
      const error = makeAxiosError({
        response: { status: 500 },
        method: "get",
      });
      await expect(mockAxios.triggerError(error)).rejects.toBe(error);
      expect(mockAxios.requestMock).not.toHaveBeenCalled();
    });

    it("does not retry on 404 Not Found", async () => {
      const error = makeAxiosError({
        response: { status: 404 },
        method: "get",
      });
      await expect(mockAxios.triggerError(error)).rejects.toBe(error);
      expect(mockAxios.requestMock).not.toHaveBeenCalled();
    });

    it("does not retry on 401 Unauthorized", async () => {
      const error = makeAxiosError({
        response: { status: 401 },
        method: "get",
      });
      await expect(mockAxios.triggerError(error)).rejects.toBe(error);
      expect(mockAxios.requestMock).not.toHaveBeenCalled();
    });

    it("does not retry 502 on POST request", async () => {
      const error = makeAxiosError({
        response: { status: 502 },
        method: "post",
      });
      await expect(mockAxios.triggerError(error)).rejects.toBe(error);
      expect(mockAxios.requestMock).not.toHaveBeenCalled();
    });

    it("does not retry 503 on PUT request", async () => {
      const error = makeAxiosError({
        response: { status: 503 },
        method: "put",
      });
      await expect(mockAxios.triggerError(error)).rejects.toBe(error);
      expect(mockAxios.requestMock).not.toHaveBeenCalled();
    });

    it("does not retry 504 on DELETE request", async () => {
      const error = makeAxiosError({
        response: { status: 504 },
        method: "delete",
      });
      await expect(mockAxios.triggerError(error)).rejects.toBe(error);
      expect(mockAxios.requestMock).not.toHaveBeenCalled();
    });

    it("does not retry unknown network error codes", async () => {
      const error = makeAxiosError({ code: "ERR_BAD_REQUEST" });
      await expect(mockAxios.triggerError(error)).rejects.toBe(error);
      expect(mockAxios.requestMock).not.toHaveBeenCalled();
    });

    it("does not retry network error with no code and no SSL message", async () => {
      const error = makeAxiosError({ message: "something broke" });
      await expect(mockAxios.triggerError(error)).rejects.toBe(error);
      expect(mockAxios.requestMock).not.toHaveBeenCalled();
    });

    it("throws immediately when error has no config", async () => {
      const error = makeAxiosError({ code: "ECONNRESET" });
      error.config = undefined as unknown as InternalAxiosRequestConfig;
      await expect(mockAxios.triggerError(error)).rejects.toBe(error);
      expect(mockAxios.requestMock).not.toHaveBeenCalled();
    });
  });

  // ── Max retries ───────────────────────────────────────────────────

  describe("max retries behavior", () => {
    it("retries up to 3 times then throws", async () => {
      const errors = [
        makeAxiosError({ code: "ECONNRESET" }),
        makeAxiosError({ code: "ECONNRESET" }),
        makeAxiosError({ code: "ECONNRESET" }),
      ];

      // Each retry call returns a new rejection
      mockAxios.requestMock
        .mockRejectedValueOnce(errors[1])
        .mockRejectedValueOnce(errors[2]);

      // Configure a fresh interceptor that chains through for retry calls
      const mockAxios2 = createMockAxios();
      const log2 = { warn: vi.fn() };
      configureRetry(mockAxios2.instance, "Retry", log2);

      // Simulate: first error handled by interceptor, interceptor calls instance.request
      // which also fails, so the interceptor is called again for the retry attempt
      // We need to simulate the full chain properly.

      // Simpler approach: track retry count via the config metadata
      const sharedConfig = { method: "get" } as InternalAxiosRequestConfig;
      const makeChainedError = () => {
        const err = makeAxiosError({ code: "ECONNRESET" });
        err.config = sharedConfig;
        return err;
      };

      // Mock request to keep failing with retryable errors
      mockAxios2.requestMock
        .mockImplementation(async (config: InternalAxiosRequestConfig) => {
          const err = new Error("ECONNRESET") as AxiosError;
          err.code = "ECONNRESET";
          err.isAxiosError = true;
          err.config = config;
          err.response = undefined;
          err.toJSON = () => ({});
          // The interceptor is called again for each retry
          return mockAxios2.triggerError(err);
        });

      const firstError = makeChainedError();

      const promise = mockAxios2.triggerError(firstError).catch((e: unknown) => e);

      // Advance through all 3 retry delays: 1s, 2s, 3s
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(3000);

      const result = await promise;
      expect(result).toBeInstanceOf(Error);
      expect(log2.warn).toHaveBeenCalledTimes(3);
      expect(mockAxios2.requestMock).toHaveBeenCalledTimes(3);
    });

    it("succeeds on second retry after first retry fails", async () => {
      const sharedConfig = { method: "get" } as InternalAxiosRequestConfig;

      const mockAxios2 = createMockAxios();
      const log2 = { warn: vi.fn() };
      configureRetry(mockAxios2.instance, "Retry", log2);

      let callCount = 0;
      mockAxios2.requestMock.mockImplementation(
        async (config: InternalAxiosRequestConfig) => {
          callCount++;
          if (callCount === 1) {
            // Second attempt also fails
            const err = new Error("ECONNRESET") as AxiosError;
            err.code = "ECONNRESET";
            err.isAxiosError = true;
            err.config = config;
            err.response = undefined;
            err.toJSON = () => ({});
            return mockAxios2.triggerError(err);
          }
          // Third attempt succeeds
          return { data: "recovered" };
        },
      );

      const firstError = makeAxiosError({ code: "ECONNRESET" });
      firstError.config = sharedConfig;

      const promise = mockAxios2.triggerError(firstError);
      await vi.advanceTimersByTimeAsync(1000); // retry 1
      await vi.advanceTimersByTimeAsync(2000); // retry 2
      const result = await promise;

      expect(result).toEqual({ data: "recovered" });
      expect(log2.warn).toHaveBeenCalledTimes(2);
    });
  });

  // ── Linear backoff delays ─────────────────────────────────────────

  describe("linear backoff", () => {
    it("uses linear backoff delays (1s, 2s, 3s)", async () => {
      const delays: number[] = [];
      const originalSetTimeout = globalThis.setTimeout;

      vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: TimerHandler,
        delay?: number,
      ) => {
        if (delay && delay >= 1000) {
          delays.push(delay);
        }
        return originalSetTimeout(fn, delay);
      }) as typeof setTimeout);

      const sharedConfig = { method: "get" } as InternalAxiosRequestConfig;
      const mockAxios2 = createMockAxios();
      const log2 = { warn: vi.fn() };
      configureRetry(mockAxios2.instance, "Backoff", log2);

      let callCount = 0;
      mockAxios2.requestMock.mockImplementation(
        async (config: InternalAxiosRequestConfig) => {
          callCount++;
          if (callCount < 3) {
            const err = new Error("ETIMEDOUT") as AxiosError;
            err.code = "ETIMEDOUT";
            err.isAxiosError = true;
            err.config = config;
            err.response = undefined;
            err.toJSON = () => ({});
            return mockAxios2.triggerError(err);
          }
          return { data: "ok" };
        },
      );

      const firstError = makeAxiosError({ code: "ETIMEDOUT" });
      firstError.config = sharedConfig;

      const promise = mockAxios2.triggerError(firstError);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      expect(delays).toEqual([1000, 2000, 3000]);

      vi.restoreAllMocks();
    });
  });

  // ── Log prefix ────────────────────────────────────────────────────

  describe("log prefix", () => {
    it("uses string log prefix in warning messages", async () => {
      const error = makeAxiosError({ code: "ECONNRESET" });
      mockAxios.requestMock.mockResolvedValue({ data: "ok" });

      const promise = mockAxios.triggerError(error);
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      expect(log.warn).toHaveBeenCalledWith(
        "TestPrefix",
        expect.stringContaining("ECONNRESET"),
      );
    });

    it("evaluates function log prefix on each retry", async () => {
      let callCount = 0;
      const prefixFn = () => `DynamicPrefix-${++callCount}`;

      const mockAxios2 = createMockAxios();
      const log2 = { warn: vi.fn() };
      configureRetry(mockAxios2.instance, prefixFn, log2);

      const sharedConfig = { method: "get" } as InternalAxiosRequestConfig;

      // First retry succeeds immediately
      mockAxios2.requestMock.mockResolvedValue({ data: "ok" });

      const error = makeAxiosError({ code: "ECONNRESET" });
      error.config = sharedConfig;

      const promise = mockAxios2.triggerError(error);
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      expect(log2.warn).toHaveBeenCalledWith(
        "DynamicPrefix-1",
        expect.stringContaining("attempt 1/3"),
      );
    });
  });

  // ── Retry count tracking ──────────────────────────────────────────

  describe("retry count in log messages", () => {
    it("logs correct attempt numbers across retries", async () => {
      const sharedConfig = { method: "get" } as InternalAxiosRequestConfig;
      const mockAxios2 = createMockAxios();
      const log2 = { warn: vi.fn() };
      configureRetry(mockAxios2.instance, "Count", log2);

      let callCount = 0;
      mockAxios2.requestMock.mockImplementation(
        async (config: InternalAxiosRequestConfig) => {
          callCount++;
          if (callCount < 3) {
            const err = new Error("EPIPE") as AxiosError;
            err.code = "EPIPE";
            err.isAxiosError = true;
            err.config = config;
            err.response = undefined;
            err.toJSON = () => ({});
            return mockAxios2.triggerError(err);
          }
          return { data: "ok" };
        },
      );

      const firstError = makeAxiosError({ code: "EPIPE" });
      firstError.config = sharedConfig;

      const promise = mockAxios2.triggerError(firstError);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      expect(log2.warn).toHaveBeenCalledWith(
        "Count",
        expect.stringContaining("attempt 1/3"),
      );
      expect(log2.warn).toHaveBeenCalledWith(
        "Count",
        expect.stringContaining("attempt 2/3"),
      );
      expect(log2.warn).toHaveBeenCalledWith(
        "Count",
        expect.stringContaining("attempt 3/3"),
      );
    });
  });
});
