// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { DataTable, type DataTableColumn } from "@/components/data-table";

interface Row {
  id: string;
  name: string;
  size: number;
}

const rows: Row[] = [
  { id: "a", name: "Charlie", size: 3 },
  { id: "b", name: "Alpha", size: 1 },
  { id: "c", name: "Bravo", size: 2 },
];

beforeEach(() => {
  localStorage.clear();
});

/** Columns built the way pages build them: a new array (and accessors) every render. */
function inlineColumns(sizeSort: (row: Row) => number, label = "Size"): DataTableColumn<Row>[] {
  return [
    { id: "name", header: "Name", accessor: (r) => r.name, sortValue: (r) => r.name, sortable: true },
    { id: "size", header: label, accessor: (r) => `${r.size} GB`, sortValue: sizeSort, sortable: true },
  ];
}

function table(columns: DataTableColumn<Row>[], extra: Record<string, unknown> = {}) {
  return createElement(DataTable<Row>, {
    columns,
    data: rows,
    keyExtractor: (r: Row) => r.id,
    defaultSortId: "size",
    ...extra,
  });
}

describe("DataTable", () => {
  it("does not re-sort when the page rebuilds its columns around the same sort function", () => {
    const sizeSort = vi.fn((r: Row) => r.size);
    const { rerender } = render(table(inlineColumns(sizeSort)));
    const calls = sizeSort.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    rerender(table(inlineColumns(sizeSort)));
    rerender(table(inlineColumns(sizeSort)));
    expect(sizeSort.mock.calls.length).toBe(calls);
  });

  it("re-sorts when the sort column's function changes (it reads values that just loaded)", () => {
    const first = vi.fn((r: Row) => r.size);
    const second = vi.fn((r: Row) => -r.size);
    const { rerender } = render(table(inlineColumns(first)));
    rerender(table(inlineColumns(second)));
    expect(second).toHaveBeenCalled();
  });

  it("renders the headers from the latest columns, not the ones its layout was built from", () => {
    const sizeSort = (r: Row) => r.size;
    const { rerender } = render(table(inlineColumns(sizeSort, "Size")));
    expect(screen.getByText("Size")).toBeTruthy();
    rerender(table(inlineColumns(sizeSort, "File size")));
    expect(screen.getByText("File size")).toBeTruthy();
    expect(screen.queryByText("Size")).toBeNull();
  });

  it("follows a change of columns, in order", () => {
    const sizeSort = (r: Row) => r.size;
    const { rerender, container } = render(table(inlineColumns(sizeSort)));
    const headerTexts = () => [...container.querySelectorAll("th")].map((th) => th.textContent?.trim());
    expect(headerTexts()).toEqual(["Name", "Size"]);
    rerender(table([...inlineColumns(sizeSort)].reverse()));
    expect(headerTexts()).toEqual(["Size", "Name"]);
  });
});
