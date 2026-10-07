import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The History page and `PlayHistory` are client components and this suite has
 * no DOM renderer, so the wiring that the pure helpers in
 * `src/lib/media/history-paging.ts` depend on is pinned from the source, the
 * same way `history-sort.test.ts` pins the page's sortable columns.
 */
function source(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

/** The text of `const <name> = …` up to the next top-level section marker. */
function block(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing ${end} after ${start}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("History page", () => {
  const page = source("src/app/(authenticated)/library/history/page.tsx");

  it("loads page 1 after a sync through the LATEST goToPage, not the one captured at click", () => {
    // A Refresh can run for minutes. Calling the goToPage the handler closed
    // over loaded page 1 of the filters/sort from before the sync, holding the
    // newest token, over the table the user had re-filtered meanwhile.
    const sync = block(page, "const handleSync = async", "// ── Multi-select");
    expect(sync).toContain("goToPageRef.current(1)");
    expect(sync).not.toMatch(/(?<![.\w])goToPage\(/);
    expect(sync).not.toMatch(/(?<![.\w])(reloadHistory|fetchHistory)\(/);
    // ...and names failed servers from the list as it is when the sync ends.
    expect(sync).not.toMatch(/failedSyncServerNames\([^)]*,\s*servers\)/);
    // The ref is kept current.
    expect(page).toMatch(/goToPageRef\.current = goToPage;/);
  });

  it("scrolls to the table's top only for a page change the user asked for", () => {
    expect(page).toMatch(/onPageChange=\{handlePageChange\}/);
    const handler = block(page, "const handlePageChange = useCallback", "}, [goToPage]);");
    expect(handler).toContain("scrollTopForPageChange(");
    expect(handler).toContain("goToPage(target)");
    // Background reloads never go through it: the only uses are its
    // definition and the pagination control.
    expect(page.match(/handlePageChange/g)?.length).toBe(2);
    // The anchor sits above the stale-data notice and the table.
    expect(page.indexOf("ref={tableTopRef}")).toBeLessThan(page.indexOf("Couldn&apos;t load watch history"));
  });
});

describe("PlayHistory", () => {
  const component = source("src/components/play-history.tsx");

  it("decides what to render with pagedListView, keeping rows over an error", () => {
    expect(component).toContain("pagedListView({ loading, error, rowCount: rows.length })");
    expect(component).not.toMatch(/\) : error \? \(/);
  });

  it("offers Retry both on the error card and beside rows kept after a failure", () => {
    const errorCard = block(component, 'view === "error" ? (', 'view === "empty" ? (');
    expect(errorCard).toContain("onClick={retry}");
    const rowsBranch = block(component, "{error && !paging && (", "<ul");
    expect(rowsBranch).toContain("onClick={retry}");
    // Pagination stays in the rows branch, so a failed page click can be
    // followed by another one.
    const afterRows = component.slice(component.indexOf("{error && !paging && ("));
    expect(afterRows.indexOf("<PaginationControls")).toBeGreaterThan(-1);
  });
});
