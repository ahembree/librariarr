import { describe, it, expect } from "vitest";
import path from "path";

// The app falls back to /config for these when they are unset. /config is
// writable in a dev container and not on CI, so a test reaching a default
// passed locally and failed there; vitest.config.ts points all of them at the
// run's own temporary directory.
describe("test runtime directories", () => {
  it.each(["BACKUP_DIR", "IMAGE_CACHE_DIR", "LOG_ARCHIVE_DIR"])("%s is set away from /config", (name) => {
    const value = process.env[name];
    expect(value, name).toBeTruthy();
    expect(path.resolve(value!).startsWith("/config"), name).toBe(false);
  });
});
