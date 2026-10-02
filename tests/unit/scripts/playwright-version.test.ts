import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// docker-compose.e2e.yml tags its Playwright image with this script's output;
// a tag that differs from the installed library has no matching browsers.
describe("scripts/playwright-version.mjs", () => {
  it("prints the installed @playwright/test version", () => {
    const printed = execFileSync("node", ["scripts/playwright-version.mjs"], { encoding: "utf8" }).trim();
    const installed = createRequire(import.meta.url)("@playwright/test/package.json").version;
    expect(printed).toBe(installed);
  });
});
