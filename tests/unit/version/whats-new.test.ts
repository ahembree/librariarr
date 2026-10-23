import { afterEach, describe, it, expect, vi } from "vitest";
import { installedVersion, whatsNewDue } from "@/lib/version/whats-new";

describe("whatsNewDue", () => {
  it("is due after an upgrade", () => {
    expect(whatsNewDue("1.2.0", "1.3.0")).toBe(true);
  });

  it("is not due on the version already seen, or after a downgrade", () => {
    expect(whatsNewDue("1.3.0", "1.3.0")).toBe(false);
    expect(whatsNewDue("1.4.0", "1.3.0")).toBe(false);
  });

  it("is due once on an install that has never recorded a version", () => {
    expect(whatsNewDue(null, "1.3.0")).toBe(true);
  });

  it("is never due without a running version", () => {
    expect(whatsNewDue(null, null)).toBe(false);
  });
});

describe("installedVersion", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the build's version without a leading v", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "v1.3.0");
    expect(installedVersion()).toBe("1.3.0");
  });

  it("is null in a build that carries none", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "unknown");
    expect(installedVersion()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "");
    expect(installedVersion()).toBeNull();
  });
});
