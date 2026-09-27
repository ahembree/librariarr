import { describe, it, expect, afterEach } from "vitest";
import {
  FORWARD_AUTH_SECRET_HEADER,
  forwardAuthSecretConfigured,
  hasForwardAuthSecret,
} from "@/lib/sso/forward-secret";

const original = process.env.FORWARD_AUTH_SECRET;

afterEach(() => {
  if (original === undefined) delete process.env.FORWARD_AUTH_SECRET;
  else process.env.FORWARD_AUTH_SECRET = original;
});

function headers(value?: string): Headers {
  const h = new Headers();
  if (value !== undefined) h.set(FORWARD_AUTH_SECRET_HEADER, value);
  return h;
}

describe("hasForwardAuthSecret", () => {
  it("lets every request through while no secret is configured (opt-in)", () => {
    delete process.env.FORWARD_AUTH_SECRET;
    expect(forwardAuthSecretConfigured()).toBe(false);
    expect(hasForwardAuthSecret(headers())).toBe(true);
    process.env.FORWARD_AUTH_SECRET = "";
    expect(forwardAuthSecretConfigured()).toBe(false);
    expect(hasForwardAuthSecret(headers("anything"))).toBe(true);
  });

  it("requires the exact secret once one is configured", () => {
    process.env.FORWARD_AUTH_SECRET = "s3cret-value";
    expect(forwardAuthSecretConfigured()).toBe(true);
    expect(hasForwardAuthSecret(headers("s3cret-value"))).toBe(true);
    expect(hasForwardAuthSecret(headers())).toBe(false);
    expect(hasForwardAuthSecret(headers(""))).toBe(false);
    expect(hasForwardAuthSecret(headers("s3cret-valuE"))).toBe(false);
    expect(hasForwardAuthSecret(headers("s3cret-value-and-more"))).toBe(false);
    expect(hasForwardAuthSecret(headers("s3cret"))).toBe(false);
  });
});
