import { describe, it, expect } from "vitest";
import { hasRecentLogin, RECENT_LOGIN_WINDOW_MS } from "@/lib/auth/recent-login";

describe("hasRecentLogin", () => {
  const now = 1_800_000_000_000;

  it("accepts a sign-in inside the window, up to its edge", () => {
    expect(hasRecentLogin({ authenticatedAt: now }, now)).toBe(true);
    expect(hasRecentLogin({ authenticatedAt: now - RECENT_LOGIN_WINDOW_MS }, now)).toBe(true);
  });

  it("refuses a sign-in older than the window", () => {
    expect(hasRecentLogin({ authenticatedAt: now - RECENT_LOGIN_WINDOW_MS - 1 }, now)).toBe(false);
  });

  it("refuses a session with no sign-in time (one from before it was stamped)", () => {
    expect(hasRecentLogin({}, now)).toBe(false);
  });

  it("is 15 minutes", () => {
    expect(RECENT_LOGIN_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});
