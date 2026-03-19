import { describe, it, expect } from "vitest";
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";

describe("sanitize", () => {
  it("returns null unchanged", () => {
    expect(sanitize(null)).toBe(null);
  });

  it("returns undefined unchanged", () => {
    expect(sanitize(undefined)).toBe(undefined);
  });

  it("returns primitives unchanged", () => {
    expect(sanitize("hello")).toBe("hello");
    expect(sanitize(42)).toBe(42);
    expect(sanitize(true)).toBe(true);
  });

  it("masks accessToken field", () => {
    const result = sanitize({ name: "Server", accessToken: "secret-token" });
    expect(result.accessToken).toBe("••••••••");
    expect(result.name).toBe("Server");
  });

  it("masks apiKey field", () => {
    const result = sanitize({ apiKey: "my-api-key", url: "http://example.com" });
    expect(result.apiKey).toBe("••••••••");
    expect(result.url).toBe("http://example.com");
  });

  it("masks plexToken field", () => {
    const result = sanitize({ plexToken: "plex-token-value" });
    expect(result.plexToken).toBe("••••••••");
  });

  it("masks passwordHash field", () => {
    const result = sanitize({ passwordHash: "hashed-password" });
    expect(result.passwordHash).toBe("••••••••");
  });

  it("masks backupEncryptionPassword field", () => {
    const result = sanitize({ backupEncryptionPassword: "secret-pass" });
    expect(result.backupEncryptionPassword).toBe("••••••••");
  });

  it("does not mask sensitive fields when value is null", () => {
    const result = sanitize({ accessToken: null, apiKey: null });
    expect(result.accessToken).toBe(null);
    expect(result.apiKey).toBe(null);
  });

  it("does not mask sensitive fields when value is undefined", () => {
    const result = sanitize({ accessToken: undefined });
    expect(result.accessToken).toBe(undefined);
  });

  it("recursively sanitizes nested objects", () => {
    const input = {
      server: {
        name: "Test",
        accessToken: "nested-secret",
        config: { apiKey: "nested-api-key" },
      },
    };
    const result = sanitize(input);
    expect(result.server.accessToken).toBe("••••••••");
    expect(result.server.config.apiKey).toBe("••••••••");
    expect(result.server.name).toBe("Test");
  });

  it("sanitizes arrays of objects", () => {
    const input = [
      { name: "Server 1", accessToken: "token1" },
      { name: "Server 2", accessToken: "token2" },
    ];
    const result = sanitize(input);
    expect(result[0].accessToken).toBe("••••••••");
    expect(result[1].accessToken).toBe("••••••••");
    expect(result[0].name).toBe("Server 1");
  });

  it("preserves Date objects without recursing into them", () => {
    const date = new Date("2024-01-01");
    const result = sanitize({ createdAt: date });
    expect(result.createdAt).toBe(date);
    expect(result.createdAt instanceof Date).toBe(true);
  });

  it("does not mutate the original object", () => {
    const original = { name: "Test", accessToken: "secret" };
    sanitize(original);
    expect(original.accessToken).toBe("secret");
  });

  it("handles empty objects", () => {
    expect(sanitize({})).toEqual({});
  });

  it("handles deeply nested arrays and objects", () => {
    const input = {
      items: [{ servers: [{ accessToken: "deep-secret" }] }],
    };
    const result = sanitize(input);
    expect(result.items[0].servers[0].accessToken).toBe("••••••••");
  });
});

describe("sanitizeErrorDetail", () => {
  it("returns undefined for undefined input", () => {
    expect(sanitizeErrorDetail(undefined)).toBe(undefined);
  });

  it("returns undefined for empty string", () => {
    expect(sanitizeErrorDetail("")).toBe(undefined);
  });

  it("strips .ts file paths", () => {
    const result = sanitizeErrorDetail("Error at /app/src/lib/db.ts:42");
    expect(result).toBe("Error at [internal]:42");
  });

  it("strips .js file paths", () => {
    const result = sanitizeErrorDetail("Error in /build/output/server.js");
    expect(result).toBe("Error in [internal]");
  });

  it("strips .mjs file paths", () => {
    const result = sanitizeErrorDetail("Module /opt/node_modules/lib.mjs failed");
    expect(result).toBe("Module [internal] failed");
  });

  it("strips 127.x.x.x localhost addresses", () => {
    const result = sanitizeErrorDetail("Cannot connect to 127.0.0.1:5432");
    expect(result).toBe("Cannot connect to [internal]:5432");
  });

  it("strips 10.x.x.x private IPs", () => {
    const result = sanitizeErrorDetail("Request to 10.0.1.50 timed out");
    expect(result).toBe("Request to [internal] timed out");
  });

  it("strips 172.16-31.x.x private IPs", () => {
    const result = sanitizeErrorDetail("Host 172.16.0.1 unreachable");
    expect(result).toBe("Host [internal] unreachable");
  });

  it("strips 192.168.x.x private IPs", () => {
    const result = sanitizeErrorDetail("Server at 192.168.1.100 is down");
    expect(result).toBe("Server at [internal] is down");
  });

  it("strips multiple paths and IPs in one string", () => {
    const result = sanitizeErrorDetail(
      "Error in /src/lib/auth.ts connecting to 10.0.0.5 via /app/server.js"
    );
    expect(result).toBe(
      "Error in [internal] connecting to [internal] via [internal]"
    );
  });

  it("leaves public IPs untouched", () => {
    const result = sanitizeErrorDetail("Connected to 8.8.8.8");
    expect(result).toBe("Connected to 8.8.8.8");
  });

  it("leaves non-sensitive strings unchanged", () => {
    const result = sanitizeErrorDetail("Something went wrong");
    expect(result).toBe("Something went wrong");
  });
});
