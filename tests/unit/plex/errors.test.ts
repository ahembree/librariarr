import { describe, it, expect } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import { describePlexError } from "@/lib/plex/errors";

function makeAxiosError(opts: {
  method?: string;
  url?: string;
  status?: number;
  data?: unknown;
  message?: string;
}): AxiosError {
  const config = {
    method: opts.method ?? "put",
    url: opts.url ?? "/library/collections/col1/items",
    headers: new AxiosHeaders(),
  };
  const err = new AxiosError(
    opts.message ?? "Request failed with status code 400",
    "ERR_BAD_REQUEST",
    config as never,
    undefined,
    opts.status === undefined
      ? undefined
      : {
          status: opts.status,
          statusText: "",
          data: opts.data,
          headers: new AxiosHeaders(),
          config: config as never,
        },
  );
  return err;
}

describe("describePlexError", () => {
  it("includes method, path and status for a Plex 400 with a string body", () => {
    const msg = describePlexError(
      makeAxiosError({ method: "post", url: "/library/collections", status: 400, data: "Invalid uri" }),
    );
    expect(msg).toBe("POST /library/collections → HTTP 400: Invalid uri");
  });

  it("extracts a message field from an object body", () => {
    const msg = describePlexError(
      makeAxiosError({ status: 400, data: { message: "unknown metadata item" } }),
    );
    expect(msg).toBe("PUT /library/collections/col1/items → HTTP 400: unknown metadata item");
  });

  it("stringifies an object body with no message field", () => {
    const msg = describePlexError(makeAxiosError({ status: 400, data: { error: "bad" } }));
    expect(msg).toContain("HTTP 400");
    expect(msg).toContain('{"error":"bad"}');
  });

  it("drops HTML error pages (reverse-proxy 400s) and falls back to the axios message", () => {
    const msg = describePlexError(
      makeAxiosError({ status: 400, data: "<html><body><h1>400 Bad Request</h1></body></html>" }),
    );
    expect(msg).not.toContain("<html>");
    expect(msg).toBe(
      "PUT /library/collections/col1/items → HTTP 400 (Request failed with status code 400)",
    );
  });

  it("strips the query string (which carries the token) from the path", () => {
    const msg = describePlexError(
      makeAxiosError({ url: "/library/collections/col1/items?X-Plex-Token=secret", status: 400, data: "nope" }),
    );
    expect(msg).not.toContain("secret");
    expect(msg).toContain("PUT /library/collections/col1/items → HTTP 400");
  });

  it("masks an X-Plex-Token echoed back inside the response body", () => {
    const msg = describePlexError(
      makeAxiosError({ status: 400, data: "failed for uri X-Plex-Token=abc123&foo=1" }),
    );
    expect(msg).not.toContain("abc123");
    expect(msg).toContain("X-Plex-Token=***");
  });

  it("reports NETWORK when there is no response", () => {
    const msg = describePlexError(makeAxiosError({ message: "connect ECONNREFUSED" }));
    expect(msg).toContain("HTTP NETWORK");
    expect(msg).toContain("connect ECONNREFUSED");
  });

  it("falls back to the message for a plain Error", () => {
    expect(describePlexError(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error value", () => {
    expect(describePlexError("weird")).toBe("weird");
  });
});
