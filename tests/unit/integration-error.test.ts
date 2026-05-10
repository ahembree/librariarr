import { describe, it, expect } from "vitest";
import type { AxiosError } from "axios";
import { IntegrationError } from "@/lib/integration-error";

function makeAxiosError(overrides: Partial<AxiosError> = {}): AxiosError {
  return {
    isAxiosError: true,
    name: "AxiosError",
    message: "Request failed",
    code: undefined,
    config: undefined,
    response: undefined,
    request: undefined,
    toJSON: () => ({}),
    ...overrides,
  } as AxiosError;
}

describe("IntegrationError", () => {
  it("formats network failures concisely with code and url", () => {
    const err = makeAxiosError({
      code: "ECONNREFUSED",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: { url: "/api/v3/movie" } as any,
    });
    const ie = new IntegrationError("Radarr", err);
    expect(ie.message).toBe("Radarr unreachable (/api/v3/movie): ECONNREFUSED");
    expect(ie.status).toBeNull();
    expect(ie.code).toBe("ECONNREFUSED");
    expect(ie.service).toBe("Radarr");
  });

  it("falls back to ERR when no code is present", () => {
    const err = makeAxiosError({ message: "boom" });
    const ie = new IntegrationError("Sonarr", err);
    expect(ie.message).toBe("Sonarr unreachable: ERR");
  });

  it("formats HTTP errors with status and url", () => {
    const err = makeAxiosError({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: { url: "/api/v1/request" } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: { status: 404, data: undefined } as any,
    });
    const ie = new IntegrationError("Seerr", err);
    expect(ie.message).toBe("Seerr HTTP 404 (/api/v1/request)");
    expect(ie.status).toBe(404);
  });

  it("includes detail from JSON body's `message` field", () => {
    const err = makeAxiosError({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: { status: 400, data: { message: "Movie not found" } } as any,
    });
    const ie = new IntegrationError("Radarr", err);
    expect(ie.message).toContain("HTTP 400");
    expect(ie.message).toContain("Movie not found");
    expect(ie.detail).toBe("Movie not found");
  });

  it("includes detail from JSON body's `error` field", () => {
    const err = makeAxiosError({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: { status: 401, data: { error: "Invalid API key" } } as any,
    });
    const ie = new IntegrationError("Sonarr", err);
    expect(ie.detail).toBe("Invalid API key");
  });

  it("includes short text bodies as detail", () => {
    const err = makeAxiosError({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: { status: 500, data: "internal server error" } as any,
    });
    const ie = new IntegrationError("Lidarr", err);
    expect(ie.detail).toBe("internal server error");
  });

  it("skips HTML error-page bodies (reverse-proxy 502s)", () => {
    const data = "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>...</body></html>";
    const err = makeAxiosError({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: { status: 502, data } as any,
    });
    const ie = new IntegrationError("Seerr", err);
    expect(ie.detail).toBeNull();
    expect(ie.message).toBe("Seerr HTTP 502");
  });

  it("truncates very long detail strings", () => {
    const longMsg = "x".repeat(500);
    const err = makeAxiosError({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: { status: 400, data: { message: longMsg } } as any,
    });
    const ie = new IntegrationError("Radarr", err);
    expect(ie.detail!.length).toBe(200);
  });

  it("preserves the original AxiosError as `cause`", () => {
    const err = makeAxiosError({ code: "ETIMEDOUT" });
    const ie = new IntegrationError("Sonarr", err);
    expect(ie.cause).toBe(err);
  });

  it("sets name to IntegrationError so consumers can detect it", () => {
    const err = makeAxiosError();
    const ie = new IntegrationError("Sonarr", err);
    expect(ie.name).toBe("IntegrationError");
    expect(ie).toBeInstanceOf(Error);
  });
});
