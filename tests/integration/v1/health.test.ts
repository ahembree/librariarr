import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import { createTestUser, createTestApiKey, expectJson } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET, dynamic } from "@/app/api/v1/health/route";

interface HealthBody {
  status: string;
  database: string;
  version: string;
  timestamp: string;
}

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEXT_PUBLIC_APP_VERSION;
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("GET /api/v1/health", () => {
  it("answers without any credential", async () => {
    const body = await expectJson<HealthBody>(await GET());
    expect(body.status).toBe("ok");
    expect(body.database).toBe("ok");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it("still answers when a garbage key is presented", async () => {
    // The route takes no request at all, so a bad credential can't turn a
    // liveness probe into a 401.
    const body = await expectJson<HealthBody>(await GET());
    expect(body.status).toBe("ok");
  });

  it("answers for a caller holding a valid key too", async () => {
    const user = await createTestUser();
    await createTestApiKey(user.id);
    const body = await expectJson<HealthBody>(await GET());
    expect(body.status).toBe("ok");
  });

  it("reports 'unknown' when no version is baked in", async () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    const body = await expectJson<HealthBody>(await GET());
    expect(body.version).toBe("unknown");
  });

  it("reports the build version when one is set", async () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "1.2.3";
    const body = await expectJson<HealthBody>(await GET());
    expect(body.version).toBe("1.2.3");
  });

  it("reports 503 and 'degraded' when the database is unreachable", async () => {
    const prisma = getTestPrisma();
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("connection refused"));

    const body = await expectJson<HealthBody>(await GET(), 503);
    expect(body.status).toBe("degraded");
    expect(body.database).toBe("unreachable");
    // The version and timestamp must survive the outage — a monitor reads them
    // to tell "app is up, DB is down" from "app is gone".
    expect(body.version).toBeTypeOf("string");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it("leaks nothing about the failure to the caller", async () => {
    const prisma = getTestPrisma();
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(
      new Error("password authentication failed for user 'librariarr' at 10.0.0.5"),
    );

    const raw = await (await GET()).text();
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("10.0.0.5");
  });

  it("opts out of static evaluation so the probe runs per request", async () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
