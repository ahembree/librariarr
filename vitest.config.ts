import { defineConfig } from "vitest/config";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";

// The app keeps its runtime files under /config (backups, the image cache, the
// log archive) unless an env var points elsewhere. A test that reached one of
// those defaults passed wherever /config is writable — a dev container — and
// failed on CI, where it is not, so each test file had to remember to point the
// variable at a temporary directory itself. Every run gets its own directory
// instead; a test that needs a separate one still sets the variable itself.
const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "librariarr-test-"));
process.on("exit", () => rmSync(runtimeDir, { recursive: true, force: true }));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    globalSetup: ["./tests/setup/global-setup.ts"],
    setupFiles: ["./tests/setup/mock-session.ts"],
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 30000,
    pool: "forks",
    sequence: {
      concurrent: false,
    },
    fileParallelism: false,
    env: {
      // The same server global-setup creates the database on.
      DATABASE_URL: `${process.env.TEST_DATABASE_URL ?? "postgresql://librariarr:librariarr@localhost:5432"}/librariarr_test`,
      // file deepcode ignore HardcodedNonCryptoSecret/test: test file
      SESSION_SECRET:
        "test-secret-must-be-at-least-32-characters-long!!",
      BACKUP_DIR: path.join(runtimeDir, "backups"),
      IMAGE_CACHE_DIR: path.join(runtimeDir, "cache", "images"),
      LOG_ARCHIVE_DIR: path.join(runtimeDir, "logs"),
    },
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/app/api/**/*.ts"],
      exclude: ["src/generated/**"],
    },
  },
});
