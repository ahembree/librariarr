import { describe, it, expect } from "vitest";
import { MAX_SKIP, clampSkip, isFullListingLimit, parseListPagination } from "@/lib/api/pagination";

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

  it("treats every spelling of zero the handlers parse as zero as no limit", () => {
    for (const limit of ["00", "+0", "-0", "0.0", "0e0", " 0", "0abc"]) {
      expect(parseListPagination(params({ limit })).limit, limit).toBe(0);
    }
    // `parseInt("0x")` is NaN — a default page, not a full listing.
    expect(parseListPagination(params({ limit: "0x" })).limit).toBe(50);
  });

  it("bounds an absurd page or offset to the Postgres OFFSET range", () => {
    // Live: a 500 from Prisma (`skip` no longer an integer) and from raw SQL
    // (`ValueOutOfRange`) — a page past the end is just an empty page.
    const huge = "99999999999999999999";
    const byPage = parseListPagination(params({ page: huge, limit: "50" }));
    expect(byPage.skip).toBe(MAX_SKIP);
    expect(Number.isSafeInteger(byPage.page)).toBe(true);
    expect(parseListPagination(params({ limit: "0", offset: huge })).skip).toBe(MAX_SKIP);
    // The product overflows even when the page alone does not.
    expect(parseListPagination(params({ page: String(MAX_SKIP), limit: "100" })).skip).toBe(MAX_SKIP);
  });
});

describe("isFullListingLimit", () => {
  it.each(["0", "00", "+0", "-0", "0.0", "0e0", " 0", "0abc", "0x0"])("%j is a full listing", (raw) => {
    expect(isFullListingLimit(raw)).toBe(true);
  });

  it.each(["1", "50", "-1", "abc", "", "0x", "x0", ".0"])("%j is not", (raw) => {
    expect(isFullListingLimit(raw)).toBe(false);
  });

  it("is not for an absent parameter", () => {
    expect(isFullListingLimit(null)).toBe(false);
  });

  it("agrees with parseListPagination for every spelling", () => {
    for (const raw of ["0", "00", "+0", "-0", "0.0", "0e0", " 0", "0abc", "0x0", "0x", "1", "abc", ""]) {
      expect(isFullListingLimit(raw), raw).toBe(parseListPagination(params({ limit: raw })).limit === 0);
    }
  });
});

describe("clampSkip", () => {
  it("passes an ordinary offset through", () => {
    expect(clampSkip(0)).toBe(0);
    expect(clampSkip(4950)).toBe(4950);
    expect(clampSkip(MAX_SKIP)).toBe(MAX_SKIP);
  });

  it("caps at the Postgres integer bound", () => {
    expect(clampSkip(MAX_SKIP + 1)).toBe(MAX_SKIP);
    expect(clampSkip(1e20)).toBe(MAX_SKIP);
    expect(clampSkip(Infinity)).toBe(MAX_SKIP);
  });

  it("floors at zero and reads NaN as the first page", () => {
    expect(clampSkip(-5)).toBe(0);
    expect(clampSkip(NaN)).toBe(0);
    expect(clampSkip(-Infinity)).toBe(0);
  });

  it("truncates a fractional offset", () => {
    expect(clampSkip(2.9)).toBe(2);
  });
});
