import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end tests. Kept entirely separate from the Vitest unit/
 * integration suite and EXCLUDED from the production Docker image (see
 * .dockerignore — e2e/, this file, and reports are never copied; @playwright/test
 * is a devDependency and is not traced into the Next.js standalone output).
 *
 * Two ways to run:
 *
 *   1. Containerized (portable, no browser download — the recommended path):
 *        pnpm e2e:docker
 *      Brings up Postgres + the real production app image + the official
 *      Playwright image (browsers pre-baked) via docker-compose.e2e.yml. The
 *      Playwright container sets E2E_BASE_URL=http://app:3000, so the webServer
 *      block below is skipped and it drives the app over the compose network.
 *
 *   2. Host/in-process (needs a one-time browser download):
 *        pnpm build && pnpm e2e:install && pnpm e2e
 *      The webServer block builds the schema and runs `next start` locally.
 *
 * A dedicated database is used so e2e never touches the dev or unit-test DB.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);

// When E2E_BASE_URL is set, Playwright targets an app already running elsewhere
// (e.g. the `app` service in docker-compose.e2e.yml, driven from the official
// Playwright image) and does NOT start its own server. Otherwise it builds +
// starts the app in-process via the webServer block below.
const EXTERNAL_BASE_URL = process.env.E2E_BASE_URL;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`;

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://librariarr:librariarr@localhost:5432/librariarr_e2e";

// A fixed ≥32-char secret so sessions survive the test run deterministically.
const E2E_SESSION_SECRET =
  process.env.E2E_SESSION_SECRET ?? "e2e-session-secret-at-least-32-chars-long!!";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // single-admin app + shared DB → run serially
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  globalSetup: "./e2e/global-setup.ts",

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    // 1. Creates the admin through the real setup UI and saves the auth state.
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    // 2. Authenticated journeys reuse the saved session.
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/admin.json" },
      dependencies: ["setup"],
      testMatch: /.*\.spec\.ts/,
      testIgnore: /unauthenticated\.spec\.ts/,
    },
    // 3. Unauthenticated journeys (auth guard, login page) with a clean state.
    {
      name: "chromium-anon",
      use: { ...devices["Desktop Chrome"], storageState: { cookies: [], origins: [] } },
      dependencies: ["setup"],
      testMatch: /unauthenticated\.spec\.ts/,
    },
  ],

  // Skipped when targeting an external app (E2E_BASE_URL set — e.g. the
  // docker-compose `app` service); otherwise builds + serves the app in-process.
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        // Ensure the schema exists on the e2e DB, then serve the built app.
        // (Prisma 7: --url, no --skip-generate.)
        command: `pnpm exec prisma db push --url "${E2E_DATABASE_URL}" --accept-data-loss && pnpm exec next start -p ${PORT} -H 127.0.0.1`,
        url: `${BASE_URL}/api/health`,
        timeout: 180_000,
        reuseExistingServer: !process.env.CI,
        env: {
          DATABASE_URL: E2E_DATABASE_URL,
          SESSION_SECRET: E2E_SESSION_SECRET,
          NODE_ENV: "production",
          NEXT_TELEMETRY_DISABLED: "1",
        },
      },
});
