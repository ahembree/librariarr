import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";
import {
  MAX_PASSWORD_BYTES,
  PASSWORD_TOO_GUESSABLE_MESSAGE,
  PASSWORD_TOO_LONG_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  isGuessablePassword,
  newPasswordProblem,
  passwordByteLength,
} from "@/lib/auth/password-rules";

/** A password of exactly `length` ASCII characters that no rule but length can object to. */
const ofLength = (length: number) => "correct-horse-battery-staple-".repeat(4).slice(0, length);
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
    expect(newPasswordProblem("vr7-Kp2q")).toBeNull();
    expect(newPasswordProblem(ofLength(MAX_PASSWORD_BYTES))).toBeNull();
  });

  it("refuses fewer than 8 characters", () => {
    expect(newPasswordProblem("1234567")).toBe(PASSWORD_TOO_SHORT_MESSAGE);
  });

  it("refuses more than 72 bytes", () => {
    expect(newPasswordProblem(ofLength(MAX_PASSWORD_BYTES + 1))).toBe(PASSWORD_TOO_LONG_MESSAGE);
  });

  it("counts UTF-8 bytes, the unit bcrypt truncates in", () => {
    const accented = "éàüñ".repeat(9) + "é"; // 37 characters, 74 bytes
    expect(accented).toHaveLength(37);
    expect(passwordByteLength(accented)).toBe(74);
    expect(newPasswordProblem(accented)).toBe(PASSWORD_TOO_LONG_MESSAGE);
    expect(newPasswordProblem("éàüñ".repeat(9))).toBeNull();
  });
});

describe("the schemas that set a password", () => {
  it("setup refuses a password bcrypt would truncate", () => {
    expect(authSetupSchema.safeParse({ username: "admin", password: ofLength(72) }).success).toBe(true);
    const result = authSetupSchema.safeParse({ username: "admin", password: ofLength(73) });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => [i.path.join("."), i.message])).toEqual([
      ["password", PASSWORD_TOO_LONG_MESSAGE],
    ]);
  });

  it("change-password refuses a new password bcrypt would truncate, and keeps it optional", () => {
    expect(changePasswordSchema.safeParse({ newUsername: "admin" }).success).toBe(true);
    expect(changePasswordSchema.safeParse({ newPassword: ofLength(72) }).success).toBe(true);
    const tooLong = changePasswordSchema.safeParse({ newPassword: ofLength(73) });
    expect(tooLong.error?.issues.map((i) => i.message)).toEqual([PASSWORD_TOO_LONG_MESSAGE]);
    const tooShort = changePasswordSchema.safeParse({ newPassword: "short" });
    expect(tooShort.error?.issues.map((i) => i.message)).toEqual([PASSWORD_TOO_SHORT_MESSAGE]);
  });
});

// The login limiter allows a few thousand guesses a day against the one admin
// account, so "at least 8 characters" has to exclude what a guessing run
// reaches in that many tries.
describe("isGuessablePassword", () => {
  it.each([
    "password", "Password123", "PASSWORD1", "qwertyuiop", "1qaz2wsx", "iloveyou", "trustno1", "changeme",
    "admin123", "librariarr",
  ])("refuses the common password %s", (password) => {
    expect(isGuessablePassword(password)).toBe(true);
    expect(newPasswordProblem(password)).toBe(PASSWORD_TOO_GUESSABLE_MESSAGE);
  });

  it.each(["12345678", "123456789", "1234567890", "87654321", "abcdefgh", "hgfedcba", "0987654321"])(
    "refuses the straight run %s",
    (password) => {
      expect(isGuessablePassword(password)).toBe(true);
    },
  );

  it.each(["aaaaaaaa", "abababab", "aaaabbbb", "112211221122", "abcabcabc"])(
    "refuses %s, fewer than four different characters",
    (password) => {
      expect(isGuessablePassword(password)).toBe(true);
    },
  );

  it.each(["Welcome2024!", "plex1234", "Summer2025", "P@ssw0rd1", "admin!!!!", "server123456", "123password", "L3tm31n99"])(
    "refuses %s, a common word dressed up with digits and punctuation",
    (password) => {
      expect(isGuessablePassword(password)).toBe(true);
    },
  );

  it.each([
    "correct horse battery staple",
    "vr7-Kp2q",
    "newpassword123",
    "securepassword",
    "e2e-password-123",
    "my plex server is great",
    "Tr0ub4dor&3",
    "summer-holiday-in-wales",
    "blue42green17",
  ])("accepts %s", (password) => {
    expect(isGuessablePassword(password)).toBe(false);
    expect(newPasswordProblem(password)).toBeNull();
  });

  it("is reported by the schemas that set a password, after the length rules", () => {
    const setup = authSetupSchema.safeParse({ username: "admin", password: "password123" });
    expect(setup.error?.issues.map((i) => [i.path.join("."), i.message])).toEqual([
      ["password", PASSWORD_TOO_GUESSABLE_MESSAGE],
    ]);
    const change = changePasswordSchema.safeParse({ newPassword: "12345678" });
    expect(change.error?.issues.map((i) => i.message)).toEqual([PASSWORD_TOO_GUESSABLE_MESSAGE]);
    // A short password gets the length message alone.
    const short = authSetupSchema.safeParse({ username: "admin", password: "abc" });
    expect(short.error?.issues.map((i) => i.message)).toEqual([PASSWORD_TOO_SHORT_MESSAGE]);
  });
});
