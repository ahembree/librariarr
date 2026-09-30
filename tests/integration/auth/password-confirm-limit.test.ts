import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, createTestUser } from "../../setup/test-helpers";
import { authGlobalRateLimiter, authRateLimiter } from "@/lib/rate-limit/rate-limiter";

// file deepcode ignore NoHardcodedPasswords/test: test file

// The REAL limiter throughout: reauth.test.ts and change-password.test.ts
// mock it, so only this file shows the budget itself — one bucket shared by
// every password confirmation on a signed-in route, charged as each attempt
// starts and given back on a match. (The API-key step-up's share of it is in
// settings/api-keys.test.ts.)

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST as reauthPasswordPOST } from "@/app/api/auth/reauth/password/route";
import { POST as changePasswordPOST } from "@/app/api/auth/local/change-password/route";

const prisma = getTestPrisma();
const PASSWORD = "correct horse battery";

async function signInWithPassword() {
  const user = await createTestUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: bcrypt.hashSync(PASSWORD, 4) },
  });
  await prisma.appSettings.create({ data: { userId: user.id, localAuthEnabled: true } });
  // An old sign-in: the password is what these routes ask for.
  setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: 1 });
  return user;
}

const confirm = (password: string) =>
  callRoute(reauthPasswordPOST, { url: "/api/auth/reauth/password", method: "POST", body: { password } });
const change = (currentPassword: string) =>
  callRoute(changePasswordPOST, {
    url: "/api/auth/local/change-password",
    method: "POST",
    body: { currentPassword, newPassword: "a brand new password" },
  });

describe("the password-confirmation budget", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterEach(() => {
    for (const limiter of [authRateLimiter, authGlobalRateLimiter]) {
      (limiter as unknown as { store: Map<string, unknown> }).store.clear();
    }
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // Charged only after a failed compare, every request of a concurrent burst
  // passed the check while the bcrypt compares ran.
  it("gives a burst of concurrent wrong passwords at /api/auth/reauth/password ten guesses", async () => {
    await signInWithPassword();
    const compare = vi.spyOn(bcrypt, "compare");
    try {
      const statuses = (await Promise.all(Array.from({ length: 25 }, () => confirm("nope")))).map((r) => r.status);
      // Ten passwords tried, not one per request.
      expect(compare).toHaveBeenCalledTimes(10);
      expect(statuses.filter((s) => s === 403)).toHaveLength(10);
      expect(statuses.filter((s) => s === 429)).toHaveLength(15);
      expect((await confirm(PASSWORD)).status).toBe(429);
    } finally {
      compare.mockRestore();
    }
  });

  it("does the same for a credential change", async () => {
    await signInWithPassword();
    const compare = vi.spyOn(bcrypt, "compare");
    try {
      const statuses = (await Promise.all(Array.from({ length: 25 }, () => change("nope")))).map((r) => r.status);
      expect(compare).toHaveBeenCalledTimes(10);
      expect(statuses.filter((s) => s === 401)).toHaveLength(10);
      expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    } finally {
      compare.mockRestore();
    }
  });

  // A bucket per route would add a fresh budget of guesses per route.
  it("counts guesses spent confirming against a credential change, and the other way round", async () => {
    await signInWithPassword();
    for (let i = 0; i < 5; i++) expect((await confirm("nope")).status).toBe(403);
    for (let i = 0; i < 5; i++) expect((await change("nope")).status).toBe(401);
    expect((await change(PASSWORD)).status).toBe(429);
    expect((await confirm(PASSWORD)).status).toBe(429);
  });

  it("never counts a right password", async () => {
    await signInWithPassword();
    for (let i = 0; i < 12; i++) expect((await confirm(PASSWORD)).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await confirm("nope")).status).toBe(403);
    expect((await confirm("nope")).status).toBe(429);
  });

  // Charged before the session check, anyone could keep the admin from
  // changing their credentials without signing in at all.
  it("is never charged by a request that is not signed in", async () => {
    for (let i = 0; i < 20; i++) expect((await change("nope")).status).toBe(401);
    await signInWithPassword();
    expect((await change(PASSWORD)).status).toBe(200);
  });
});
