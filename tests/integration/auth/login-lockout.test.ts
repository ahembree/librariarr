import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession, getMockSession } from "../../setup/mock-session";
import { callRoute, createTestUser } from "../../setup/test-helpers";
import {
  _resetKnownAddressesForTesting,
  authGlobalRateLimiter,
  authRateLimiter,
} from "@/lib/rate-limit/rate-limiter";

// file deepcode ignore NoHardcodedPasswords/test: test file

/**
 * The REAL limiter against the real login route. Every other login test mocks
 * the limiter, so this file is the only one that shows what the budget does:
 *
 * - a sign-in that succeeds costs nothing, however many there are;
 * - sixty failures from anywhere spend the global floor — but an address a
 *   sign-in has succeeded from is never refused by it. Before, those sixty
 *   failures (four a minute, from a rotating or shared address) locked the
 *   admin out of the login for the rest of the window, and the sender could
 *   keep it that way for as long as they liked.
 */

const mockCompare = vi.hoisted(() => vi.fn());
vi.mock("bcryptjs", () => ({ default: { compare: mockCompare }, compare: mockCompare }));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "@/app/api/auth/local/login/route";

const prisma = getTestPrisma();
const ADMIN_ADDRESS = "203.0.113.7";
const PASSWORD = "correct horse battery";

const login = (password: string, address: string) =>
  callRoute(POST, {
    url: "/api/auth/local/login",
    method: "POST",
    headers: { "x-forwarded-for": address },
    body: { username: "admin", password },
  });

async function seedAdmin() {
  const user = await createTestUser({ username: "admin" });
  await prisma.user.update({
    where: { id: user.id },
    data: { localUsername: "admin", passwordHash: "hashed" },
  });
  await prisma.appSettings.create({ data: { userId: user.id, localAuthEnabled: true } });
  mockCompare.mockImplementation(async (candidate: string) => candidate === PASSWORD);
  return user;
}

/** Sixty wrong passwords, each from a different forwarded address. */
async function floodFromRotatingAddresses() {
  const statuses: number[] = [];
  for (let i = 0; i < 60; i++) {
    statuses.push((await login("wrong", `10.0.${Math.floor(i / 256)}.${i % 256}`)).status);
  }
  return statuses;
}

describe("the login budget (real limiter)", () => {
  const originalTrust = process.env.TRUST_PROXY_HEADERS;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    delete process.env.TRUST_PROXY_HEADERS;
  });

  afterEach(() => {
    for (const limiter of [authRateLimiter, authGlobalRateLimiter]) {
      (limiter as unknown as { store: Map<string, unknown> }).store.clear();
    }
    _resetKnownAddressesForTesting();
    if (originalTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = originalTrust;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("never charges a sign-in that succeeds", async () => {
    await seedAdmin();
    for (let i = 0; i < 25; i++) {
      expect((await login(PASSWORD, ADMIN_ADDRESS)).status).toBe(200);
    }
    // Ten wrong passwords are still available to that address afterwards.
    for (let i = 0; i < 10; i++) expect((await login("wrong", ADMIN_ADDRESS)).status).toBe(401);
    expect((await login("wrong", ADMIN_ADDRESS)).status).toBe(429);
  });

  it("refuses an address after ten failures, and only that address", async () => {
    await seedAdmin();
    for (let i = 0; i < 10; i++) expect((await login("wrong", "10.9.0.1")).status).toBe(401);
    const refused = await login(PASSWORD, "10.9.0.1");
    expect(refused.status).toBe(429);
    // Seconds left in the 15-minute window the first failure opened.
    const retryAfter = Number(refused.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
    expect(getMockSession().isLoggedIn).toBe(false);
    expect((await login(PASSWORD, "10.9.0.2")).status).toBe(200);
  });

  it("holds a flood from rotating addresses to the global floor", async () => {
    await seedAdmin();
    expect((await floodFromRotatingAddresses()).every((s) => s === 401)).toBe(true);
    // The sixty-first, from yet another fresh address, is refused — even with
    // the right password, and without the password being compared.
    mockCompare.mockClear();
    expect((await login(PASSWORD, "10.9.9.9")).status).toBe(429);
    expect(mockCompare).not.toHaveBeenCalled();
  });

  it("does not let that flood lock out an address the admin has signed in from", async () => {
    await seedAdmin();
    expect((await login(PASSWORD, ADMIN_ADDRESS)).status).toBe(200);
    clearMockSession();

    await floodFromRotatingAddresses();
    expect((await login(PASSWORD, "10.9.9.9")).status).toBe(429);

    // The admin's address is judged by its own budget alone.
    expect((await login("typo", ADMIN_ADDRESS)).status).toBe(401);
    const ok = await login(PASSWORD, ADMIN_ADDRESS);
    expect(ok.status).toBe(200);
    expect(getMockSession().isLoggedIn).toBe(true);
  });

  it("with proxy headers distrusted, every client is one address, and one sign-in exempts it from the floor", async () => {
    process.env.TRUST_PROXY_HEADERS = "false";
    await seedAdmin();
    expect((await login(PASSWORD, "1.1.1.1")).status).toBe(200);
    // The floor spent in full: the one shared address a sign-in has succeeded
    // from is not refused by it.
    for (let i = 0; i < 60; i++) authGlobalRateLimiter.check("login:*");
    expect((await login(PASSWORD, "4.4.4.4")).status).toBe(200);
    // Ten failures, whatever address each claims, fill the one shared
    // per-address bucket.
    for (let i = 0; i < 10; i++) expect((await login("wrong", `2.2.2.${i}`)).status).toBe(401);
    expect((await login(PASSWORD, "3.3.3.3")).status).toBe(429);
  });
});
