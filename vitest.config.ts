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
      // Same base as tests/setup/global-setup.ts, so TEST_DATABASE_URL points
      // both the schema push and the test client at one server.
      DATABASE_URL: `${
        process.env.TEST_DATABASE_URL ??
        "postgresql://librariarr:librariarr@localhost:5432"
      }/librariarr_test`,
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
