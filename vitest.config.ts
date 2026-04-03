import { defineConfig } from "vitest/config";
import path from "path";

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
      DATABASE_URL:
        "postgresql://librariarr:librariarr@localhost:5432/librariarr_test",
      // file deepcode ignore HardcodedNonCryptoSecret/test: test file
      SESSION_SECRET:
        "test-secret-must-be-at-least-32-characters-long!!",
    },
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/app/api/**/*.ts"],
      exclude: ["src/generated/**"],
    },
  },
});
