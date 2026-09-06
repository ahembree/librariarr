import { describe, it, expect } from "vitest";
import { QUALITY_ORDER } from "@/lib/resolution";
import { firstNonNullSql, qualityCountsSql, resolutionLabelSql } from "@/lib/media/series-sql";

describe("series-sql fragments", () => {
  it("firstNonNullSql orders and filters on the given column", () => {
    expect(firstNonNullSql(`"studio"`, `"seasonNumber", "episodeNumber"`)).toBe(
      `(array_agg("studio" ORDER BY "seasonNumber", "episodeNumber") FILTER (WHERE "studio" IS NOT NULL))[1]`,
    );
  });

  it("qualityCountsSql emits one bucket per QUALITY_ORDER entry", () => {
    const sql = qualityCountsSql("resolution_label");
    for (const label of QUALITY_ORDER) {
      expect(sql).toContain(`'${label}', NULLIF(COUNT(*) FILTER (WHERE resolution_label = '${label}'), 0)`);
    }
    expect(sql.startsWith("jsonb_strip_nulls(jsonb_build_object(")).toBe(true);
  });

  it("resolutionLabelSql uses the TS helper's thresholds", () => {
    const sql = resolutionLabelSql("r");
    expect(sql).toContain(">= 2000 THEN '4K'");
    expect(sql).toContain(">= 900 THEN '1080P'");
    expect(sql).toContain(">= 600 THEN '720P'");
    expect(sql).toContain(">= 300 THEN '480P'");
  });
});
