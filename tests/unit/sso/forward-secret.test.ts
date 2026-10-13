import { describe, it, expect, afterEach } from "vitest";
import { FORWARD_AUTH_PROXY_HEADER, hasForwardAuthSecret, isForwardAuthSecretConfigured } from "@/lib/sso/forward-secret";

const original = process.env.FORWARD_AUTH_SECRET;

afterEach(() => {
  if (original === undefined) delete process.env.FORWARD_AUTH_SECRET;
  else process.env.FORWARD_AUTH_SECRET = original;
});

function headers(value?: string): Headers {
  const h = new Headers();
  if (value !== undefined) h.set(FORWARD_AUTH_PROXY_HEADER, value);
  return h;
}

describe("isForwardAuthSecretConfigured", () => {
  it("is true only for a non-empty value", () => {
    delete process.env.FORWARD_AUTH_SECRET;
    expect(isForwardAuthSecretConfigured()).toBe(false);
    process.env.FORWARD_AUTH_SECRET = "";
    expect(isForwardAuthSecretConfigured()).toBe(false);
    process.env.FORWARD_AUTH_SECRET = "s3cret-value";
    expect(isForwardAuthSecretConfigured()).toBe(true);
  });
});

describe("hasForwardAuthSecret", () => {
  // It used to let every request through while unset ("opt-in"), which meant
  // any client that reached the app's port directly could sign in by sending
  // the identity header itself. Unset, forward-auth is not usable at all.
  it("refuses every request while no secret is configured", () => {
    delete process.env.FORWARD_AUTH_SECRET;
    expect(hasForwardAuthSecret(headers())).toBe(false);
    expect(hasForwardAuthSecret(headers("anything"))).toBe(false);
    process.env.FORWARD_AUTH_SECRET = "";
    expect(hasForwardAuthSecret(headers("anything"))).toBe(false);
    expect(hasForwardAuthSecret(headers(""))).toBe(false);
  });

  it("requires the exact secret once one is configured", () => {
    process.env.FORWARD_AUTH_SECRET = "s3cret-value";
    expect(hasForwardAuthSecret(headers("s3cret-value"))).toBe(true);
    expect(hasForwardAuthSecret(headers())).toBe(false);
    expect(hasForwardAuthSecret(headers(""))).toBe(false);
    expect(hasForwardAuthSecret(headers("s3cret-valuE"))).toBe(false);
    expect(hasForwardAuthSecret(headers("s3cret"))).toBe(false);
  });

  // Only the configured value's length of the presented value is compared
  // byte by byte, so a longer value that starts with the secret must still
  // fail on its length.
  it("refuses a longer value that starts with the secret", () => {
    process.env.FORWARD_AUTH_SECRET = "s3cret-value";
    expect(hasForwardAuthSecret(headers("s3cret-value-and-more"))).toBe(false);
    expect(hasForwardAuthSecret(headers("s3cret-valuex"))).toBe(false);
  });
});
