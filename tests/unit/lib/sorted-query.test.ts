import { describe, it, expect } from "vitest";
import { sortedQueryString } from "@/lib/sorted-query";

describe("sortedQueryString", () => {
  it("orders parameters by name, then value, and keeps repeats", () => {
    expect(sortedQueryString(new URLSearchParams("b=2&a=1&a=0"))).toBe("a=0&a=1&b=2");
  });

  it("gives one string for one set of parameters in any order", () => {
    expect(sortedQueryString(new URLSearchParams("limit=0&sortBy=title"))).toBe(
      sortedQueryString(new URLSearchParams("sortBy=title&limit=0")),
    );
  });

  it("encodes values the way URLSearchParams does", () => {
    expect(sortedQueryString(new URLSearchParams([["q", "a b&c"]]))).toBe("q=a+b%26c");
    expect(sortedQueryString(new URLSearchParams())).toBe("");
  });
});
