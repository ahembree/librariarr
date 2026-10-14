import { describe, expect, it } from "vitest";
import { isTruthyFlag } from "@/lib/env-flag";

describe("isTruthyFlag", () => {
  it("accepts true, 1 and yes in any case, trimmed", () => {
    for (const value of ["true", "TRUE", " True ", "1", "yes", "YES"]) expect(isTruthyFlag(value)).toBe(true);
  });

  it("is off for anything else, unset included", () => {
    for (const value of [undefined, null, "", "false", "0", "no", "on", "enabled"]) expect(isTruthyFlag(value)).toBe(false);
  });
});
