import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DATE_ONLY_FIELDS } from "@/lib/conditions/fields";

const SRC = path.join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(full);
    return /\.tsx$/.test(entry.name) ? [full] : [];
  });
}

// The registry's date-only fields plus the Plex/Arr property names they come
// from, should a page ever render one straight off an API payload.
const DATE_ONLY_NAMES = [...DATE_ONLY_FIELDS, "inCinemas", "physicalRelease", "digitalRelease", "firstAired", "airDate"];
const NAME = new RegExp(`\\b(${DATE_ONLY_NAMES.join("|")})\\b`);
// A local-time formatter: `formatDate(` (not `formatDateOnly(`) or a bare
// `toLocale…String(`.
const LOCAL_FORMAT = /\bformatDate\(|\.toLocale(Date)?String\(/;

describe("date-only values in the UI", () => {
  // A release or air date is a calendar day stored as UTC midnight. Formatted
  // in the viewer's local time it showed the day before anywhere west of UTC
  // ("Released July 15, 2010" for a 2010-07-16 release in Los Angeles), so
  // every page formats one with formatDateOnly.
  it("never formats a date-only field in local time", () => {
    expect(DATE_ONLY_FIELDS.has("originallyAvailableAt")).toBe(true);
    const offenders = sourceFiles(SRC).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          NAME.test(line) && LOCAL_FORMAT.test(line) ? [`${path.relative(process.cwd(), file)}:${i + 1}`] : [],
        ),
    );
    expect(offenders).toEqual([]);
  });
});
