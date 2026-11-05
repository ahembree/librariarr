import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { INTEGRATION_APP_STYLES } from "@/lib/theme/integration-colors";

const GLOBALS = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

describe("integration identity colours", () => {
  it("styles every integration from its own app-* token", () => {
    for (const [app, style] of Object.entries(INTEGRATION_APP_STYLES)) {
      for (const classes of Object.values(style)) {
        expect(classes).toContain(`app-${app}`);
        expect(classes).not.toMatch(/-(sky|amber|emerald|violet|cyan)-\d{3}/);
      }
    }
  });

  it("declares each token and maps it into Tailwind", () => {
    for (const app of Object.keys(INTEGRATION_APP_STYLES)) {
      expect(GLOBALS).toMatch(new RegExp(`--app-${app}:\\s*oklch\\(`));
      expect(GLOBALS).toContain(`--color-app-${app}: var(--app-${app});`);
    }
  });
});
