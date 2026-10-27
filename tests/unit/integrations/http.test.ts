import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AxiosError, InternalAxiosRequestConfig } from "axios";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { instance, createSpy } = vi.hoisted(() => {
  const instance = {
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  };
  return { instance, createSpy: vi.fn(() => instance) };
});

vi.mock("axios", () => ({
  default: {
    create: createSpy,
    isAxiosError: (e: unknown) => e instanceof Error && "isAxiosError" in e,
  },
}));

import { apiKeyHeaders, createIntegrationHttp } from "@/lib/integrations/http";
import { IntegrationError } from "@/lib/integration-error";
import { logger } from "@/lib/logger";

function failure(status: number): AxiosError {
  const error = new Error(`Request failed with status code ${status}`) as AxiosError;
  error.isAxiosError = true;
  error.code = "ERR_BAD_RESPONSE";
  error.config = { url: "/api/v3/movie", method: "get" } as InternalAxiosRequestConfig;
  error.response = { status, data: { message: "nope" } } as AxiosError["response"];
  error.toJSON = () => ({});
  return error;
}

describe("createIntegrationHttp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("strips only trailing slashes, keeping a base path", () => {
    createIntegrationHttp("Radarr", "https://host/radarr///", { a: "b" }, { timeout: 1234 });
    expect(createSpy).toHaveBeenCalledWith({
      baseURL: "https://host/radarr",
      headers: { a: "b" },
      timeout: 1234,
    });
  });

  it("registers the retry before the IntegrationError conversion", () => {
    createIntegrationHttp("Radarr", "http://x", {}, { timeout: 1 });
    // configureRetry's handler first (no fulfilled handler), the converter last.
    const calls = instance.interceptors.response.use.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBeUndefined();
    expect(typeof calls[1][1]).toBe("function");
  });

  it("stamps a start time and converts an axios failure, logging its duration", async () => {
    createIntegrationHttp("Seerr", "http://x", {}, { timeout: 1 });
    const stamp = instance.interceptors.request.use.mock.calls[0][0] as (c: Record<string, unknown>) => Record<string, unknown>;
    const [onFulfilled, onRejected] = instance.interceptors.response.use.mock.calls[1] as [
      (r: unknown) => unknown,
      (e: unknown) => Promise<never>,
    ];
    const config = stamp({ url: "/x" });
    expect(typeof config.__startTime).toBe("number");
    const ok = { data: 1 };
    expect(onFulfilled(ok)).toBe(ok);

    const err = failure(404);
    (err.config as unknown as Record<string, unknown>).__startTime = Date.now() - 3;
    const rejected = await onRejected(err).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(IntegrationError);
    expect((rejected as IntegrationError).service).toBe("Seerr");
    expect((rejected as IntegrationError).status).toBe(404);
    expect(vi.mocked(logger.debug).mock.calls[0][1]).toMatch(/^ERROR 404 \/api\/v3\/movie \(\d+ms\)$/);
  });

  it("passes a non-axios failure through unchanged", async () => {
    createIntegrationHttp("Lidarr", "http://x", {}, { timeout: 1 });
    const onRejected = instance.interceptors.response.use.mock.calls[1][1] as (e: unknown) => Promise<never>;
    const plain = new Error("boom");
    await expect(onRejected(plain)).rejects.toBe(plain);
  });
});

describe("apiKeyHeaders", () => {
  it("sends the key and JSON content negotiation", () => {
    expect(apiKeyHeaders("k")).toEqual({
      "X-Api-Key": "k",
      Accept: "application/json",
      "Content-Type": "application/json",
    });
  });
});
