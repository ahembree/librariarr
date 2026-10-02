import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";
import {
  MAX_PASSWORD_BYTES,
  PASSWORD_TOO_LONG_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  newPasswordProblem,
  passwordByteLength,
} from "@/lib/auth/password-rules";
import { authSetupSchema, changePasswordSchema } from "@/lib/validation";

describe("the bcrypt limit the rule exists for", () => {
  it("ignores everything past 72 bytes, so two different long passwords would both work", async () => {
    const stem = "x".repeat(72);
    const hash = await bcrypt.hash(`${stem}first-ending`, 4);
    expect(await bcrypt.compare(`${stem}a-different-ending`, hash)).toBe(true);
  });
});

describe("newPasswordProblem", () => {
  it("accepts 8 characters up to 72 bytes", () => {
    expect(newPasswordProblem("12345678")).toBeNull();
    expect(newPasswordProblem("x".repeat(MAX_PASSWORD_BYTES))).toBeNull();
  });

  it("refuses fewer than 8 characters", () => {
    expect(newPasswordProblem("1234567")).toBe(PASSWORD_TOO_SHORT_MESSAGE);
  });

  it("refuses more than 72 bytes", () => {
    expect(newPasswordProblem("x".repeat(MAX_PASSWORD_BYTES + 1))).toBe(PASSWORD_TOO_LONG_MESSAGE);
  });

  it("counts UTF-8 bytes, the unit bcrypt truncates in", () => {
    const accented = "é".repeat(37); // 37 characters, 74 bytes
    expect(accented).toHaveLength(37);
    expect(passwordByteLength(accented)).toBe(74);
    expect(newPasswordProblem(accented)).toBe(PASSWORD_TOO_LONG_MESSAGE);
    expect(newPasswordProblem("é".repeat(36))).toBeNull();
  });
});

describe("the schemas that set a password", () => {
  it("setup refuses a password bcrypt would truncate", () => {
    expect(authSetupSchema.safeParse({ username: "admin", password: "x".repeat(72) }).success).toBe(true);
    const result = authSetupSchema.safeParse({ username: "admin", password: "x".repeat(73) });
    expect(result.success).toBe(false);
  });

  it("change-password refuses a new password bcrypt would truncate, and keeps it optional", () => {
    expect(changePasswordSchema.safeParse({ newUsername: "admin" }).success).toBe(true);
    expect(changePasswordSchema.safeParse({ newPassword: "x".repeat(72) }).success).toBe(true);
    expect(changePasswordSchema.safeParse({ newPassword: "x".repeat(73) }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ newPassword: "short" }).success).toBe(false);
  });
});
