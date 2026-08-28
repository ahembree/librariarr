import { describe, it, expect } from "vitest";
import { parseListPagination } from "@/lib/api/pagination";

const params = (q: Record<string, string>) => new URLSearchParams(q);

describe("parseListPagination", () => {
  it("defaults to page 1 with a 50-item limit", () => {
    expect(parseListPagination(params({}))).toEqual({ page: 1, limit: 50, skip: 0 });
  });

  it("derives skip from the page when no offset is given", () => {
    expect(parseListPagination(params({ page: "3", limit: "20" }))).toEqual({
      page: 3, limit: 20, skip: 40,
    });
  });

  it("treats limit=0 as no limit", () => {
    expect(parseListPagination(params({ limit: "0" }))).toMatchObject({ limit: 0, skip: 0 });
  });

  it("lets an explicit offset override the page-derived skip", () => {
    // This is what makes progressive loading work: fetch the first screenful,
    // then everything after it without refetching.
    expect(parseListPagination(params({ limit: "0", offset: "100" }))).toMatchObject({
      limit: 0, skip: 100,
    });
    expect(parseListPagination(params({ page: "5", limit: "20", offset: "7" }))).toMatchObject({
      skip: 7,
    });
  });

  it("clamps the limit to the maximum", () => {
    expect(parseListPagination(params({ limit: "5000" })).limit).toBe(100);
  });

  it("rejects a negative limit rather than reverse-taking", () => {
    expect(parseListPagination(params({ limit: "-10" })).limit).toBe(1);
  });

  it("falls back to the default limit for a malformed value", () => {
    expect(parseListPagination(params({ limit: "abc" })).limit).toBe(50);
  });

  it("ignores a malformed or negative offset", () => {
    expect(parseListPagination(params({ page: "2", limit: "10", offset: "abc" })).skip).toBe(10);
    expect(parseListPagination(params({ limit: "0", offset: "-5" })).skip).toBe(0);
  });

  it("clamps a bad page to 1", () => {
    expect(parseListPagination(params({ page: "0" })).page).toBe(1);
    expect(parseListPagination(params({ page: "-3" })).page).toBe(1);
    expect(parseListPagination(params({ page: "abc" })).page).toBe(1);
  });
});
