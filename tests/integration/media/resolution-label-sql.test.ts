import { describe, it, expect, afterAll } from "vitest";
import { disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { normalizeResolutionLabel, resolutionLabelSql } from "@/lib/resolution";

/**
 * Locks the SQL twin to the TS function: the series and season listings label
 * quality in SQL, every other consumer in TS, and the two must agree for a
 * show's chips to match its seasons'.
 */
describe("resolutionLabelSql", () => {
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("labels every sample exactly like normalizeResolutionLabel", async () => {
    const samples = [
      null, "", "4k", "4K", "2160", "2160p", "1080", "1080p", "720", "720p", "480", "480p",
      "360", "360p", "sd", "SD", "1024p", "1024", "872p", "536p", "400", "2048", "1999",
      "900", "899", "600", "599", "300", "299", "abc", "1080i", "hd", "720p60", "p1080", "4kp",
      "0", "12345678901234567890", " 1080", "1080 ",
    ];
    const prisma = getTestPrisma();
    const rows = await prisma.$queryRawUnsafe<{ input: string | null; label: string }[]>(
      `SELECT v AS input, ${resolutionLabelSql("v")} AS label
         FROM unnest($1::text[]) AS v`,
      samples,
    );
    expect(rows).toHaveLength(samples.length);
    for (const row of rows) {
      expect({ input: row.input, label: row.label }).toEqual({
        input: row.input,
        label: normalizeResolutionLabel(row.input),
      });
    }
  });
});
