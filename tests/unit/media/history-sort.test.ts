import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HISTORY_COLUMN_SORT_KEY,
  HISTORY_SORT_KEYS,
  HISTORY_SORT_SQL,
  HISTORY_TYPE_SORT_ORDER,
  historyColumnForSortKey,
  historySortKeyForColumn,
  historySortSql,
  isHistorySortableColumn,
} from "@/lib/media/history-sort";
import { QUALITY_ORDER, resolutionLabelSql } from "@/lib/resolution";
import { MEDIA_TYPE_LABELS } from "@/lib/theme/media-type-colors";

/**
 * Column ids the History page declares with a `sortValue` (a clickable header),
 * read from the page source: the column list lives inside the component.
 */
function pageSortableColumnIds(): string[] {
  const source = readFileSync(
    join(process.cwd(), "src/app/(authenticated)/library/history/page.tsx"),
    "utf8",
  );
  const blocks = source.split(/\n\s*\{\n\s*id: "/).slice(1);
  return blocks
    .map((block) => ({ id: block.slice(0, block.indexOf('"')), body: block.split(/\n\s{4}\},?\n/)[0] }))
    .filter(({ body }) => body.includes("sortValue:"))
    .map(({ id }) => id);
}

describe("history sort map", () => {
  it("maps every column one-to-one onto the route's SQL whitelist", () => {
    expect(Object.keys(HISTORY_SORT_SQL).sort()).toEqual([...HISTORY_SORT_KEYS].sort());
    const keys = Object.values(HISTORY_COLUMN_SORT_KEY);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [column, key] of Object.entries(HISTORY_COLUMN_SORT_KEY)) {
      expect(Object.hasOwn(HISTORY_SORT_SQL, key)).toBe(true);
      expect(HISTORY_SORT_SQL[key].length).toBeGreaterThan(0);
      expect(historyColumnForSortKey(key)).toBe(column);
      expect(historySortKeyForColumn(column)).toBe(key);
    }
  });

  it.each([
    // Server by server name, User by username.
    ["server", "serverName"],
    ["serverUsername", "serverUsername"],
    ["dynamicRange", "dynamicRange"],
    ["videoCodec", "videoCodec"],
    ["audioCodec", "audioCodec"],
  ])("sorts the %s column by %s", (column, key) => {
    expect(historySortKeyForColumn(column)).toBe(key);
    expect(historyColumnForSortKey(key)).toBe(column);
  });

  it("gives every sortable column on the page a route sort key", () => {
    const ids = pageSortableColumnIds();
    // Guards the parser: the page has well over a dozen sortable columns.
    expect(ids.length).toBeGreaterThan(10);
    expect(ids).toContain("server");
    for (const id of ids) {
      expect(isHistorySortableColumn(id), `column "${id}" has no sort key`).toBe(true);
    }
  });

  it("falls back to Watched At for unknown and prototype-chain keys", () => {
    expect(historySortSql("nope")).toEqual(HISTORY_SORT_SQL.watchedAt);
    expect(historySortSql("constructor")).toEqual(HISTORY_SORT_SQL.watchedAt);
    expect(historySortKeyForColumn("constructor")).toBe("watchedAt");
    expect(historyColumnForSortKey("toString")).toBe("watchedAt");
    expect(isHistorySortableColumn("__proto__")).toBe(false);
  });
});

describe("history sort SQL for displayed labels", () => {
  /** `CASE … WHEN '<label>' THEN <n> …` → the labels in rank order. */
  function rankedLabels(sql: string): string[] {
    return [...sql.matchAll(/WHEN '([^']+)' THEN (\d+)/g)]
      .map(([, label, rank]) => ({ label, rank: Number(rank) }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ label }) => label);
  }

  it.each([
    ["resolution", 'mi."resolution"'],
    ["streamResolution", 'wh."resolution"'],
  ] as const)("ranks %s by its normalized label, lowest first", (key, column) => {
    const [rank, raw] = HISTORY_SORT_SQL[key];
    // The label is the SQL twin of normalizeResolutionLabel, over the right column.
    expect(rank).toContain(resolutionLabelSql(column));
    // Only the outer CASE maps a label to a numeric rank; "Other" is unranked (NULL, last).
    expect(rankedLabels(rank)).toEqual(["SD", "480P", "720P", "1080P", "4K"]);
    expect(rankedLabels(rank).sort()).toEqual(QUALITY_ORDER.filter((l) => l !== "Other").sort());
    expect(raw).toBe(`NULLIF(LOWER(${column}), '')`);
  });

  it("sorts Type by the label the column shows, not the enum's declaration order", () => {
    const shown = Object.keys(MEDIA_TYPE_LABELS).sort((a, b) =>
      MEDIA_TYPE_LABELS[a].localeCompare(MEDIA_TYPE_LABELS[b]),
    );
    expect([...HISTORY_TYPE_SORT_ORDER]).toEqual(shown);
    expect(rankedLabels(HISTORY_SORT_SQL.type[0])).toEqual(shown);
  });
});
