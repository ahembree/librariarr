import { describe, it, expect } from "vitest";
import {
  BUILTIN_COLUMN_FIELDS,
  QUERY_COLUMN_FIELD_DEFS,
  QUERY_COLUMN_FIELDS,
  columnSectionLabel,
  columnHeader,
  criterionColumnId,
  formatColumnValue,
  columnSortValue,
} from "@/lib/query/column-fields";
import { CONDITION_FIELDS } from "@/lib/conditions/fields";
import type { ConditionField } from "@/lib/conditions/types";

function def(value: string): ConditionField {
  const d = CONDITION_FIELDS.find((f) => f.value === value);
  if (!d) throw new Error(`no field ${value}`);
  return d;
}

const text: ConditionField = { value: "custom", label: "Custom", type: "text", section: "content" };
const dateDef: ConditionField = { value: "someDate", label: "Some Date", type: "date", section: "content" };
const numDef: ConditionField = { value: "someNum", label: "Some Num", type: "number", section: "content" };

describe("query column registry", () => {
  it("offers every condition field except the fixed table columns", () => {
    for (const f of CONDITION_FIELDS) {
      expect(QUERY_COLUMN_FIELDS.has(f.value)).toBe(!BUILTIN_COLUMN_FIELDS.has(f.value));
    }
    expect(QUERY_COLUMN_FIELD_DEFS.length).toBe(QUERY_COLUMN_FIELDS.size);
    expect(QUERY_COLUMN_FIELDS.has("title")).toBe(false);
  });

  it("labels sections, passing an unknown section through", () => {
    expect(columnSectionLabel("arrMedia")).toBe("Arr: Media");
    expect(columnSectionLabel("mystery")).toBe("mystery");
  });

  it("prefixes Arr field headers, but not twice or for non-Arr fields", () => {
    expect(columnHeader(def("arrReleaseDate"))).toBe("Arr Release Date");
    expect(columnHeader({ ...def("arrTag"), label: "Arr Tag" })).toBe("Arr Tag");
    expect(columnHeader(text)).toBe("Custom");
  });

  it("namespaces a criterion column id", () => {
    expect(criterionColumnId("arrTag")).toBe("field:arrTag");
  });
});

describe("formatColumnValue", () => {
  it("renders missing values and empty lists as a dash", () => {
    expect(formatColumnValue(text, null)).toBe("-");
    expect(formatColumnValue(text, undefined)).toBe("-");
    expect(formatColumnValue(text, [])).toBe("-");
  });

  it("joins lists and renders booleans as Yes/No", () => {
    expect(formatColumnValue(text, ["a", "b"])).toBe("a, b");
    expect(formatColumnValue(text, true)).toBe("Yes");
    expect(formatColumnValue(text, false)).toBe("No");
  });

  it("formats valid dates and dashes invalid ones", () => {
    // Cells show the viewer's local calendar day: local noon on 5 March is
    // 5 March in every timezone (a fixed UTC instant is 6 March east of +12).
    expect(formatColumnValue(dateDef, new Date(2024, 2, 5, 12).toISOString())).toBe("Mar 5, 2024");
    expect(formatColumnValue(dateDef, "garbage")).toBe("-");
  });

  it("formats bytes, minutes and percentages by field", () => {
    expect(formatColumnValue(def("arrSizeOnDisk"), 1024 * 1024)).toBe("1.0 MB");
    expect(formatColumnValue(def("arrRuntime"), 95)).toBe("95 min");
    expect(formatColumnValue(def("watchedEpisodePercentage"), 33.333)).toBe("33.3%");
  });

  it("groups integers and rounds fractions to two places", () => {
    expect(formatColumnValue(numDef, 1234567)).toBe("1,234,567");
    expect(formatColumnValue(numDef, 1.23456)).toBe("1.23");
  });

  it("passes plain strings through", () => {
    expect(formatColumnValue(text, "Hello")).toBe("Hello");
  });
});

describe("columnSortValue", () => {
  it("sorts missing values and empty lists as null", () => {
    expect(columnSortValue(text, null)).toBeNull();
    expect(columnSortValue(text, undefined)).toBeNull();
    expect(columnSortValue(text, [])).toBeNull();
  });

  it("sorts lists by their lowercased joined text", () => {
    expect(columnSortValue(text, ["B", "a"])).toBe("b, a");
  });

  it("sorts booleans as 1/0 and numbers as themselves", () => {
    expect(columnSortValue(text, true)).toBe(1);
    expect(columnSortValue(text, false)).toBe(0);
    expect(columnSortValue(numDef, 4.5)).toBe(4.5);
  });

  it("sorts dates by timestamp, invalid ones as null", () => {
    expect(columnSortValue(dateDef, "2024-01-01T00:00:00Z")).toBe(Date.UTC(2024, 0, 1));
    expect(columnSortValue(dateDef, "nope")).toBeNull();
  });

  it("sorts text case-insensitively", () => {
    expect(columnSortValue(text, "ZeTa")).toBe("zeta");
  });
});
