/**
 * The addresses a sign-in has succeeded from, in their table: what the login
 * rate limiter reads back after a restart (see rate-limiter.ts).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  KNOWN_ADDRESS_TTL_MS,
  loadKnownAddresses,
  saveKnownAddress,
} from "@/lib/rate-limit/known-addresses";
import {
  _resetKnownAddressesForTesting,
  authGlobalRateLimiter,
  authRateLimiter,
  isKnownAddress,
  knownAddressesLoaded,
  peekAuthRateLimit,
  reserveAuthAttempt,
} from "@/lib/rate-limit/rate-limiter";

const prisma = getTestPrisma();
const request = (ip: string) =>
  new Request("http://localhost/api/auth/local/login", { headers: { "x-forwarded-for": ip } });

beforeEach(async () => {
  await cleanDatabase();
  authRateLimiter.clear();
  authGlobalRateLimiter.clear();
  _resetKnownAddressesForTesting();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("the known-address store", () => {
  it("keeps one row per address, moving its time forward", async () => {
    const now = Date.now();
    await saveKnownAddress("198.51.100.7", now - 5000);
    await saveKnownAddress("198.51.100.7", now);
    await saveKnownAddress("unknown", now);

    const rows = await prisma.knownSignInAddress.findMany({ orderBy: { address: "asc" } });
    expect(rows.map((row) => row.address)).toEqual(["198.51.100.7", "unknown"]);
    expect(rows[0].lastSignInAt.getTime()).toBe(now);
  });

  it("returns only addresses within their 30 days, with when each expires, and prunes the rest on a write", async () => {
    const now = Date.now();
    await prisma.knownSignInAddress.createMany({
      data: [
        { address: "old", lastSignInAt: new Date(now - KNOWN_ADDRESS_TTL_MS - 1000) },
        { address: "recent", lastSignInAt: new Date(now - 1000) },
      ],
    });

    expect(await loadKnownAddresses(now)).toEqual([{ address: "recent", until: now - 1000 + KNOWN_ADDRESS_TTL_MS }]);

    await saveKnownAddress("new", now);
    expect((await prisma.knownSignInAddress.findMany()).map((row) => row.address).sort()).toEqual(["new", "recent"]);
  });
});

describe("the login limiter across a restart", () => {
  it("still exempts the admin's address from a flood of failures", async () => {
    // Before the restart: the admin signs in.
    const attempt = reserveAuthAttempt(request("198.51.100.7"), "login");
    if (attempt.refused) throw new Error("refused");
    attempt.succeeded();
    await vi.waitFor(async () => expect(await prisma.knownSignInAddress.count()).toBe(1));

    // The restart: every count and every remembered address is gone from memory.
    authRateLimiter.clear();
    authGlobalRateLimiter.clear();
    _resetKnownAddressesForTesting();
    await knownAddressesLoaded();

    // Sixty wrong passwords from rotating addresses fill the floor…
    for (let i = 0; i < 60; i++) reserveAuthAttempt(request(`203.0.113.${i}`), "login");
    expect(peekAuthRateLimit(request("192.0.2.200"), "login")?.status).toBe(429);
    // …which the admin's address is not judged by.
    expect(isKnownAddress("198.51.100.7")).toBe(true);
    expect(peekAuthRateLimit(request("198.51.100.7"), "login")).toBeNull();
  });
});
