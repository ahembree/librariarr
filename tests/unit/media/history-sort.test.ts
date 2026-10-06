import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HISTORY_COLUMN_SORT_KEY,
  HISTORY_SORT_KEYS,
  HISTORY_SORT_SQL,
  historyColumnForSortKey,
  historySortKeyForColumn,
  historySortSql,
  isHistorySortableColumn,
} from "@/lib/media/history-sort";

/**
 * Column ids the History page declares with a `sortValue` (i.e. a clickable
 * header), read from the page source — the column list lives inside the
 * component, so this is the only way to hold the page to the shared map.
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
  it("maps every column to a key the route can sort by", () => {
    for (const key of Object.values(HISTORY_COLUMN_SORT_KEY)) {
      expect(Object.hasOwn(HISTORY_SORT_SQL, key)).toBe(true);
      expect(HISTORY_SORT_SQL[key].length).toBeGreaterThan(0);
    }
  });

  it("covers every sort key in the SQL whitelist", () => {
    expect(Object.keys(HISTORY_SORT_SQL).sort()).toEqual([...HISTORY_SORT_KEYS].sort());
  });

  it("is one-to-one, so the sort arrow lands on the column that was clicked", () => {
    const keys = Object.values(HISTORY_COLUMN_SORT_KEY);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [column, key] of Object.entries(HISTORY_COLUMN_SORT_KEY)) {
      expect(historyColumnForSortKey(key)).toBe(column);
      expect(historySortKeyForColumn(column)).toBe(key);
    }
  });

  it("sorts the Server column by server name and the User column by username", () => {
    expect(historySortKeyForColumn("server")).toBe("serverName");
    expect(historySortKeyForColumn("serverUsername")).toBe("serverUsername");
    expect(historyColumnForSortKey("serverUsername")).toBe("serverUsername");
    expect(historyColumnForSortKey("serverName")).toBe("server");
  });

  it("has real sort keys for HDR, video codec and audio", () => {
    expect(historySortKeyForColumn("dynamicRange")).toBe("dynamicRange");
    expect(historySortKeyForColumn("videoCodec")).toBe("videoCodec");
    expect(historySortKeyForColumn("audioCodec")).toBe("audioCodec");
  });

  it("gives every sortable column on the page a route sort key", () => {
    const ids = pageSortableColumnIds();
    // Guard the parser itself: the page has well over a dozen sortable columns.
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
