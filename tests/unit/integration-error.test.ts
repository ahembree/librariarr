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
      config: { url: "/api/v3/movie", method: "get" } as any,
    });
    const ie = new IntegrationError("Radarr", err);
    expect(ie.message).toBe("Radarr unreachable (/api/v3/movie): ECONNREFUSED");
    expect(ie.status).toBeNull();
    expect(ie.code).toBe("ECONNREFUSED");
    expect(ie.service).toBe("Radarr");
    expect(ie.url).toBe("/api/v3/movie");
    expect(ie.method).toBe("GET");
  });

  it("falls back to ERR when no code is present", () => {
    const err = makeAxiosError({ message: "boom" });
    const ie = new IntegrationError("Sonarr", err);
    expect(ie.message).toBe("Sonarr unreachable: ERR");
    expect(ie.code).toBe("ERR");
    expect(ie.method).toBeNull();
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
    expect(ie.message).toBe("Radarr HTTP 400: Movie not found");
    expect(ie.detail).toBe("Movie not found");
  });

  it("includes the messages of an *arr validation-failure array", () => {
    const err = makeAxiosError({
      response: {
        status: 400,
        data: [
          { propertyName: "TmdbId", errorMessage: "This exclusion has already been added." },
          { propertyName: "MovieTitle", errorMessage: "'Movie Title' must not be empty." },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    const ie = new IntegrationError("Radarr", err);
    expect(ie.validationMessages).toEqual([
      "This exclusion has already been added.",
      "'Movie Title' must not be empty.",
    ]);
    expect(ie.detail).toBe("This exclusion has already been added.; 'Movie Title' must not be empty.");
    expect(ie.message).toBe(
      "Radarr HTTP 400: This exclusion has already been added.; 'Movie Title' must not be empty.",
    );
  });

  it("includes detail from JSON body's `error` field", () => {
    const err = makeAxiosError({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: { status: 401, data: { error: "Invalid API key" } } as any,
    });
    const ie = new IntegrationError("Sonarr", err);
    expect(ie.detail).toBe("Invalid API key");
  });

  // OpenAI-compatible servers and Anthropic put the reason one level down.
  it.each([
    [
      "OpenAI",
      { error: { message: "Incorrect API key provided: sk-****1234.", type: "invalid_request_error", param: null, code: "invalid_api_key" } },
      "Incorrect API key provided: sk-****1234.",
    ],
    ["Anthropic", { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "invalid x-api-key"],
  ])("includes the detail %s nests under `error.message`", (_name, data, expected) => {
    const err = makeAxiosError({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: { url: "/chat/completions" } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: { status: 401, data } as any,
    });
    const ie = new IntegrationError("AI", err);
    expect(ie.detail).toBe(expected);
    expect(ie.message).toBe(`AI HTTP 401: ${expected} (/chat/completions)`);
  });

  it("prefers a top-level message, and ignores a nested error with no usable message", () => {
    const both = makeAxiosError({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: { status: 400, data: { message: "top", error: { message: "nested" } } } as any,
    });
    expect(new IntegrationError("Seerr", both).detail).toBe("top");
    for (const error of [{ type: "x" }, { message: 42 }, { message: "  " }, null]) {
      const err = makeAxiosError({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: { status: 500, data: { error } } as any,
      });
      expect(new IntegrationError("AI", err).detail).toBeNull();
    }
  });

  it("truncates a long nested message to 200 characters", () => {
    const err = makeAxiosError({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: { status: 400, data: { error: { message: "y".repeat(500) } } } as any,
    });
    expect(new IntegrationError("AI", err).detail).toHaveLength(200);
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
    expect(ie.detail).toBe("x".repeat(200));
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
