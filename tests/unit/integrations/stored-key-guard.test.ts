import { describe, it, expect } from "vitest";
import { sendsStoredKeyToNewUrl } from "@/lib/integrations/stored-key-guard";
import { MASKED_VALUE } from "@/lib/api/sanitize";

describe("sendsStoredKeyToNewUrl", () => {
  const stored = "http://radarr:7878";

  it("flags a new URL with no new key", () => {
    expect(sendsStoredKeyToNewUrl(stored, "https://elsewhere.example", undefined)).toBe(true);
    expect(sendsStoredKeyToNewUrl(stored, "https://elsewhere.example", "")).toBe(true);
    expect(sendsStoredKeyToNewUrl(stored, "https://elsewhere.example", MASKED_VALUE)).toBe(true);
  });

  it("ignores the stored URL, trailing slashes aside, and an absent URL", () => {
    expect(sendsStoredKeyToNewUrl(stored, undefined, undefined)).toBe(false);
    expect(sendsStoredKeyToNewUrl(stored, "http://radarr:7878/", undefined)).toBe(false);
    expect(sendsStoredKeyToNewUrl("http://radarr:7878/", stored, undefined)).toBe(false);
  });

  it("does not flag a request that brings its own key", () => {
    expect(sendsStoredKeyToNewUrl(stored, "https://elsewhere.example", "new-key")).toBe(false);
  });
});
