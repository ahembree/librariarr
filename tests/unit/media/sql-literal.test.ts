import { describe, it, expect } from "vitest";
import { escapeSqlLiteral } from "@/lib/media/sql-literal";
import { TIME_REGEX } from "@/lib/validation";

describe("escapeSqlLiteral", () => {
  it("doubles every single quote", () => {
    expect(escapeSqlLiteral("Children's")).toBe("Children''s");
    expect(escapeSqlLiteral("'a'b''")).toBe("''a''b''''");
  });

  it("leaves a string without quotes untouched", () => {
    expect(escapeSqlLiteral("Not Rated")).toBe("Not Rated");
    expect(escapeSqlLiteral("")).toBe("");
  });
});

describe("TIME_REGEX", () => {
  it("accepts HH:mm from 00:00 to 23:59", () => {
    for (const t of ["00:00", "09:30", "12:00", "19:59", "23:59"]) expect(TIME_REGEX.test(t), t).toBe(true);
  });

  it("refuses an hour past 23, a minute past 59 and any other shape", () => {
    for (const t of ["24:00", "27:99", "12:60", "9:30", "09:3", "0930", "09:30:00", " 09:30"]) {
      expect(TIME_REGEX.test(t), t).toBe(false);
    }
  });
});
