import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const PAGE = path.join(process.cwd(), "src/app/(authenticated)/tools/preroll/page.tsx");

/**
 * The Preroll page's "Active" badge must say what the enforcer will play, so
 * it reads the enforcer's own window rule (`isPrerollWindowActive`, unit-tested
 * in tests/unit/maintenance/schedule-activity.test.ts) instead of keeping a
 * copy. The copy it used to keep compared a seasonal schedule's dates with the
 * year (the enforcer repeats it every year) and checked an overnight window
 * against today's weekday only, so the badge and what played disagreed. A
 * client page has no test harness here, so this pins the delegation.
 */
describe("Preroll page Active badge", () => {
  const source = readFileSync(PAGE, "utf8");

  it("imports the shared window rule", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bisPrerollWindowActive\b[^}]*\}\s*from\s*["']@\/lib\/maintenance\/schedule-activity["']/,
    );
  });

  it("decides the badge with it rather than its own date arithmetic", () => {
    const body = source.match(/function isScheduleCurrentlyActive\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
    expect(body, "isScheduleCurrentlyActive not found").toBeDefined();
    expect(body).toMatch(/\bisPrerollWindowActive\(\s*schedule\s*\)/);
    expect(body).not.toMatch(/new Date|getDay|getHours|getMonth|startTime|startDate/);
  });
});
