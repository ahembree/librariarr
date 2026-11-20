import { describe, expect, it } from "vitest";
import { HSTS_MAX_AGE_LIMIT, hstsHeaderValue } from "@/lib/security/hsts";

describe("hstsHeaderValue", () => {
  it("is off unless a number of seconds is set", () => {
    expect(hstsHeaderValue(undefined)).toBeNull();
    expect(hstsHeaderValue("")).toBeNull();
    expect(hstsHeaderValue("0")).toBeNull();
    expect(hstsHeaderValue("true")).toBeNull();
    expect(hstsHeaderValue("-5")).toBeNull();
    expect(hstsHeaderValue("31536000; includeSubDomains")).toBeNull();
  });

  it("is max-age alone — never includeSubDomains or preload", () => {
    expect(hstsHeaderValue("31536000")).toBe("max-age=31536000");
    expect(hstsHeaderValue(" 300 ")).toBe("max-age=300");
  });

  it("clamps an over-long policy to two years", () => {
    expect(hstsHeaderValue("999999999999")).toBe(`max-age=${HSTS_MAX_AGE_LIMIT}`);
  });
});
