import { describe, it, expect } from "vitest";
import {
  apiKeySession,
  getApiKeyPrincipal,
  runAsApiKey,
  type ApiKeyPrincipal,
} from "@/lib/api-keys/principal";

function principal(overrides: Partial<ApiKeyPrincipal> = {}): ApiKeyPrincipal {
  return {
    keyId: "key-1",
    userId: "user-1",
    name: "Dashboard",
    prefix: "lbr_abcdef",
    scopes: ["media:read"],
    ...overrides,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("API key principal", () => {
  it("exists only inside runAsApiKey", async () => {
    expect(getApiKeyPrincipal()).toBeUndefined();
    await runAsApiKey(principal(), async () => {
      await tick();
      expect(getApiKeyPrincipal()?.keyId).toBe("key-1");
    });
    expect(getApiKeyPrincipal()).toBeUndefined();
  });

  it("keeps concurrent requests apart", async () => {
    const seen: string[] = [];
    await Promise.all([
      runAsApiKey(principal({ keyId: "a" }), async () => {
        await tick();
        seen.push(`a:${getApiKeyPrincipal()?.keyId}`);
      }),
      runAsApiKey(principal({ keyId: "b" }), async () => {
        await tick();
        seen.push(`b:${getApiKeyPrincipal()?.keyId}`);
      }),
    ]);
    expect(seen.sort()).toEqual(["a:a", "b:b"]);
  });

  it("cannot be widened by the handler it runs", async () => {
    await runAsApiKey(principal(), async () => {
      const p = getApiKeyPrincipal()!;
      expect(() => {
        (p.scopes as string[]).push("lifecycle:execute");
      }).toThrow();
      expect(() => {
        (p as { userId: string }).userId = "someone-else";
      }).toThrow();
      expect(getApiKeyPrincipal()!.scopes).toEqual(["media:read"]);
    });
  });
});

describe("apiKeySession", () => {
  it("is logged in as the key's owner and carries nothing else", () => {
    const session = apiKeySession(principal());
    expect(session.isLoggedIn).toBe(true);
    expect(session.userId).toBe("user-1");
    expect(session.plexToken).toBeUndefined();
    expect(session.sessionVersion).toBeUndefined();
  });

  it("refuses every cookie write", async () => {
    const session = apiKeySession(principal());
    await expect(session.save()).rejects.toThrow(/no cookie session/);
    expect(() => session.destroy()).toThrow(/no cookie session/);
    expect(() => session.updateConfig({ password: "x".repeat(32), cookieName: "c" })).toThrow(
      /no cookie session/,
    );
    expect(() => {
      (session as { userId?: string }).userId = "other";
    }).toThrow();
  });
});
