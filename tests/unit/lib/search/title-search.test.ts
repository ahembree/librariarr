import { describe, it, expect } from "vitest";
import { parseTitleSearch, titleSearchFilter, titleSearchPattern } from "@/lib/search/title-search";

describe("parseTitleSearch", () => {
  it("a plain query matches anywhere in a title", () => {
    expect(parseTitleSearch("  ER ")).toEqual({ text: "ER", exact: false });
  });

  it("a quoted query is an exact title, quotes and surrounding space dropped", () => {
    expect(parseTitleSearch('"ER"')).toEqual({ text: "ER", exact: true });
    expect(parseTitleSearch('  " The Office "  ')).toEqual({ text: "The Office", exact: true });
  });

  it("the closing quote is optional, so results follow the query as it is typed", () => {
    expect(parseTitleSearch('"E')).toEqual({ text: "E", exact: true });
    expect(parseTitleSearch('"ER')).toEqual({ text: "ER", exact: true });
  });

  it("quotes alone are an exact search for nothing", () => {
    expect(parseTitleSearch('""')).toEqual({ text: "", exact: true });
    expect(parseTitleSearch('"')).toEqual({ text: "", exact: true });
  });

  it("a quote that does not open the query is part of the title", () => {
    expect(parseTitleSearch('The "Burbs')).toEqual({ text: 'The "Burbs', exact: false });
  });

  it("keeps quotes inside an exact title", () => {
    expect(parseTitleSearch('""Weird Al" Yankovic"')).toEqual({ text: '"Weird Al" Yankovic', exact: true });
  });
});

describe("titleSearchPattern", () => {
  it("is the text alone for an exact title, wrapped in % otherwise", () => {
    expect(titleSearchPattern({ text: "ER", exact: true })).toBe("ER");
    expect(titleSearchPattern({ text: "ER", exact: false })).toBe("%ER%");
  });

  it("escapes LIKE wildcards either way", () => {
    expect(titleSearchPattern({ text: "100%_", exact: true })).toBe("100\\%\\_");
    expect(titleSearchPattern({ text: "100%_", exact: false })).toBe("%100\\%\\_%");
  });
});

describe("titleSearchFilter", () => {
  it("is a case-insensitive equals for an exact title, contains otherwise, escaped", () => {
    expect(titleSearchFilter({ text: "E_R", exact: true })).toEqual({ equals: "E\\_R", mode: "insensitive" });
    expect(titleSearchFilter({ text: "E_R", exact: false })).toEqual({ contains: "E\\_R", mode: "insensitive" });
  });
});
