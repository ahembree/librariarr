import { describe, expect, it } from "vitest";
import { resolveSecretWrite } from "@/lib/sso/secret-write";

describe("resolveSecretWrite", () => {
  it("keeps the current value when the field is undefined (not sent)", () => {
    expect(resolveSecretWrite(undefined, "stored")).toBe("stored");
    expect(resolveSecretWrite(undefined, null)).toBeNull();
  });

  it("keeps the current value when the masked placeholder is echoed back", () => {
    // sanitize() emits this exact string
    expect(resolveSecretWrite("••••••••", "stored")).toBe("stored");
    // any all-bullet string counts as masked
    expect(resolveSecretWrite("••••", "stored")).toBe("stored");
  });

  it("clears the secret when explicit null is sent", () => {
    expect(resolveSecretWrite(null, "stored")).toBeNull();
  });

  it("clears the secret when an empty string is sent", () => {
    expect(resolveSecretWrite("", "stored")).toBeNull();
  });

  it("clears the secret when only whitespace is sent", () => {
    expect(resolveSecretWrite("   ", "stored")).toBeNull();
  });

  it("writes the trimmed new value when a real secret is sent", () => {
    expect(resolveSecretWrite("new-secret", "old")).toBe("new-secret");
    expect(resolveSecretWrite("  padded  ", "old")).toBe("padded");
  });

  it("does not confuse a secret containing bullet characters mid-string", () => {
    // Mixed content is treated as a real value, not the mask
    expect(resolveSecretWrite("abc••def", "stored")).toBe("abc••def");
  });
});
