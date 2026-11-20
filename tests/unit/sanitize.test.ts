import { describe, it, expect } from "vitest";
import { redactNetworkAddresses, sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";

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

  it("masks oidcClientSecret field", () => {
    const result = sanitize({ oidcClientSecret: "oidc-secret" });
    expect(result.oidcClientSecret).toBe("••••••••");
  });

  it("masks aiApiKey field", () => {
    const result = sanitize({ aiProvider: "anthropic", aiApiKey: "sk-ant-api03-secret" });
    expect(result).toEqual({ aiProvider: "anthropic", aiApiKey: "••••••••" });
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

  it("stops at a circular reference instead of recursing forever", () => {
    const server: Record<string, unknown> = { name: "Plex", accessToken: "secret" };
    server.self = server;
    const result = sanitize(server);
    expect(result).toEqual({ name: "Plex", accessToken: "••••••••", self: "[circular]" });
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

  it("strips only the private 172.16-31 range, not its neighbours", () => {
    expect(sanitizeErrorDetail("Host 172.31.255.1 unreachable")).toBe("Host [internal] unreachable");
    expect(sanitizeErrorDetail("Host 172.15.0.1 unreachable")).toBe("Host 172.15.0.1 unreachable");
    expect(sanitizeErrorDetail("Host 172.32.0.1 unreachable")).toBe("Host 172.32.0.1 unreachable");
  });

  it("strips link-local and unspecified IPv4 addresses", () => {
    expect(sanitizeErrorDetail("Bound to 169.254.10.20")).toBe("Bound to [internal]");
    expect(sanitizeErrorDetail("Listening on 0.0.0.0:32400")).toBe("Listening on [internal]:32400");
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

  it("redacts internal IPv6 addresses (loopback, ULA, link-local)", () => {
    expect(sanitizeErrorDetail("Connect ::1 failed")).toBe("Connect [internal] failed");
    expect(sanitizeErrorDetail("Host fd12:3456:789a:1::1 down")).toBe("Host [internal] down");
    expect(sanitizeErrorDetail("Link fe80::1 unreachable")).toBe("Link [internal] unreachable");
  });

  it("redacts plex.direct hostnames, which spell out the server's address", () => {
    expect(sanitizeErrorDetail("HTTP 500 (GET https://192-168-1-5.0123abcd.plex.direct:32400/library/sections): boom")).toBe(
      "HTTP 500 (GET https://[internal]:32400/library/sections): boom",
    );
    expect(sanitizeErrorDetail("Host 2001-db8--1.0123abcd.plex.direct down")).toBe("Host [internal] down");
    expect(sanitizeErrorDetail("plex.direct is a domain")).toBe("plex.direct is a domain");
  });

  it("does not over-redact a bare hex prefix or normal text (anchored segments)", () => {
    // No segment follows the prefix → not an address, must be left intact.
    expect(sanitizeErrorDetail("value fc00 only")).toBe("value fc00 only");
    // A clock-like token isn't an internal IPv6 address.
    expect(sanitizeErrorDetail("at 12:34:56")).toBe("at 12:34:56");
  });
});

describe("redactNetworkAddresses", () => {
  it("removes public addresses, names and ports that sanitizeErrorDetail keeps", () => {
    expect(redactNetworkAddresses("connect ECONNREFUSED 203.0.113.7:32400")).toBe("connect ECONNREFUSED [address]");
    expect(redactNetworkAddresses("getaddrinfo ENOTFOUND plex.example.com")).toBe("getaddrinfo ENOTFOUND [address]");
    expect(redactNetworkAddresses("getaddrinfo EAI_AGAIN media.example.org")).toBe("getaddrinfo EAI_AGAIN [address]");
  });

  it("removes the host of a URL and keeps its path", () => {
    expect(redactNetworkAddresses("HTTP 500 (GET https://plex.example.com:32400/library/sections): boom")).toBe(
      "HTTP 500 (GET [address]/library/sections): boom",
    );
    expect(redactNetworkAddresses("ws://host.example:8096/socket failed")).toBe("[address]/socket failed");
  });

  it("removes addresses with no error code beside them", () => {
    expect(redactNetworkAddresses("upstream 198.51.100.4 said no, as did [2001:db8::1]:8096")).toBe(
      "upstream [address] said no, as did [address]",
    );
  });

  it("removes the names a certificate mismatch lists", () => {
    expect(
      redactNetworkAddresses(
        "Hostname/IP does not match certificate's altnames: Host: plex.example.com. is not in the cert's altnames: DNS:other.example.net, DNS:*.example.net",
      ),
    ).toBe(
      "Hostname/IP does not match certificate's altnames: Host: [address] is not in the cert's altnames: DNS: [address], DNS: [address]",
    );
  });

  it("composes with sanitizeErrorDetail's own markers", () => {
    const stored = sanitizeErrorDetail("connect ECONNREFUSED 192.168.1.5:32400")!;
    expect(stored).toBe("connect ECONNREFUSED [internal]:32400");
    expect(redactNetworkAddresses(stored)).toBe("connect ECONNREFUSED [address]");
  });

  it("leaves text without an address alone", () => {
    const text = "Request failed with status code 401 — 12:30:45, 3 of 10 items, v1.2.3";
    expect(redactNetworkAddresses(text)).toBe(text);
  });

  // What follows these codes is the TLS or socket detail, or ordinary words —
  // replacing it garbled the message and hid nothing.
  it("leaves the text after a code that names no address", () => {
    for (const text of [
      "write EPROTO 80DB1E:error:0A00010B:SSL routines:ssl3_get_record:wrong version number",
      "read ECONNRESET at TLSWrap.onStreamRead",
      "connect ETIMEDOUT while fetching the library list",
      "request failed: ECONNREFUSED",
    ]) {
      expect(redactNetworkAddresses(text)).toBe(text);
    }
  });

  it("still removes an address a connection error names, IPv6 included", () => {
    expect(redactNetworkAddresses("connect ECONNREFUSED ::1:32400")).toBe("connect ECONNREFUSED [address]");
    expect(redactNetworkAddresses("connect EHOSTUNREACH 2001:db8::7:8096 (retry 2)")).toBe(
      "connect EHOSTUNREACH [address] (retry 2)",
    );
    expect(redactNetworkAddresses("getaddrinfo ENOTFOUND plex")).toBe("getaddrinfo ENOTFOUND [address]");
  });
});
