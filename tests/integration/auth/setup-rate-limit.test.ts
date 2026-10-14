import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import { callRoute } from "../../setup/test-helpers";
import { authGlobalRateLimiter, authRateLimiter } from "@/lib/rate-limit/rate-limiter";

/**
 * The REAL limiter against the three routes that answer anyone until the
 * first admin exists: `POST /api/auth/setup` (a bcrypt hash per call),
 * `GET /api/backup/list-setup` and `POST /api/backup/restore-setup`. They
 * share one bucket, so the budget is for the setup wizard as a whole.
 */

const mockHash = vi.hoisted(() => vi.fn());
vi.mock("bcryptjs", () => ({ default: { hash: mockHash, compare: vi.fn() }, hash: mockHash }));

const { mockListBackups, mockRestoreBackup } = vi.hoisted(() => ({
  mockListBackups: vi.fn(),
  mockRestoreBackup: vi.fn(),
}));
vi.mock("@/lib/backup/backup-service", () => ({
  listBackups: mockListBackups,
  restoreBackup: mockRestoreBackup,
}));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST as setupPOST } from "@/app/api/auth/setup/route";
import { GET as listGET } from "@/app/api/backup/list-setup/route";
import { POST as restorePOST } from "@/app/api/backup/restore-setup/route";

const from = (address: string) => ({ "x-forwarded-for": address });

describe("the setup budget (real limiter)", () => {
  const originalTrust = process.env.TRUST_PROXY_HEADERS;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    delete process.env.TRUST_PROXY_HEADERS;
    mockHash.mockResolvedValue("hashed");
    mockListBackups.mockResolvedValue([]);
    mockRestoreBackup.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const limiter of [authRateLimiter, authGlobalRateLimiter]) {
      (limiter as unknown as { store: Map<string, unknown> }).store.clear();
    }
    if (originalTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = originalTrust;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("shares ten requests per address across setup, backup listing and setup-time restore", async () => {
    for (let i = 0; i < 4; i++) {
      expect((await callRoute(listGET, { method: "GET", headers: from("10.0.0.1") })).status).toBe(200);
    }
    for (let i = 0; i < 3; i++) {
      const res = await callRoute(restorePOST, {
        method: "POST",
        headers: from("10.0.0.1"),
        body: { filename: "librariarr-backup-missing.json.gz" },
      });
      expect(res.status).toBe(200);
    }
    // Three bad setup attempts (a malformed body is still a request here:
    // none of these routes verifies a credential, so every call counts).
    for (let i = 0; i < 3; i++) {
      expect((await callRoute(setupPOST, { method: "POST", headers: from("10.0.0.1"), body: {} })).status).toBe(400);
    }
    const eleventh = await callRoute(setupPOST, {
      method: "POST",
      headers: from("10.0.0.1"),
      body: { username: "admin", password: "a-fine-password" },
    });
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("Retry-After")).toBeTruthy();
    // Refused before the hash, and before any restore.
    expect(mockHash).not.toHaveBeenCalled();
    expect((await callRoute(listGET, { method: "GET", headers: from("10.0.0.1") })).status).toBe(429);

    // Another address still sets up.
    const ok = await callRoute(setupPOST, {
      method: "POST",
      headers: from("10.0.0.2"),
      body: { username: "admin", password: "a-fine-password" },
    });
    expect(ok.status).toBe(200);
  });
});
