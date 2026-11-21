import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { apiLogger } from "@/lib/logger";
import { auditMeta, logSignInFailure } from "@/lib/auth/audit";
import { auditAddress, MAX_AUDIT_ADDRESS_LENGTH } from "@/lib/rate-limit/client-ip";

const request = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/auth/local/login", { method: "POST", headers });

describe("sign-in audit lines", () => {
  beforeEach(() => {
    vi.mocked(apiLogger.warn).mockClear();
    vi.stubEnv("TRUST_PROXY_HEADERS", "");
  });

  it("logs a failure as a WARN with the address the rate limiter buckets by", () => {
    logSignInFailure(request({ "x-forwarded-for": "10.0.0.1, 203.0.113.9" }), "password", "wrong password");
    expect(apiLogger.warn).toHaveBeenCalledWith("Auth", "Failed sign-in (password): wrong password", {
      address: "203.0.113.9",
    });
  });

  it("carries extra detail beside the address", () => {
    logSignInFailure(request(), "Plex", "Plex sign-in is turned off", { plexId: "1" });
    expect(apiLogger.warn).toHaveBeenCalledWith("Auth", "Failed sign-in (Plex): Plex sign-in is turned off", {
      address: "unknown",
      plexId: "1",
    });
  });

  it("uses the shared bucket's name when proxy headers are not trusted", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "false");
    expect(auditMeta(request({ "x-forwarded-for": "203.0.113.9" }))).toEqual({ address: "unknown" });
  });

  it("repeats a bounded part of an address a client wrote", () => {
    const address = auditAddress(request({ "x-forwarded-for": "a".repeat(500) }));
    expect(address).toHaveLength(MAX_AUDIT_ADDRESS_LENGTH);
  });
});
