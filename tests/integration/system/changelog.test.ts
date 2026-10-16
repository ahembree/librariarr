import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { expectJson, createTestUser } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockFetchChangelog } = vi.hoisted(() => ({ mockFetchChangelog: vi.fn() }));
vi.mock("@/lib/version/update-checker", () => ({ fetchChangelog: mockFetchChangelog }));

import { GET } from "@/app/api/system/changelog/route";

describe("GET /api/system/changelog", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth and never calls GitHub", async () => {
    await expectJson(await GET(), 401);
    expect(mockFetchChangelog).not.toHaveBeenCalled();
  });

  it("returns the release notes", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const notes = [
      { version: "1.2.0", name: "v1.2.0", body: "Fixes", publishedAt: "2026-01-01T00:00:00Z", url: "https://x" },
    ];
    mockFetchChangelog.mockResolvedValue(notes);
    const body = await expectJson<{ notes: unknown[] }>(await GET(), 200);
    expect(body.notes).toEqual(notes);
    expect(mockFetchChangelog).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list when no notes are available", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    mockFetchChangelog.mockResolvedValue([]);
    const body = await expectJson<{ notes: unknown[] }>(await GET(), 200);
    expect(body.notes).toEqual([]);
  });
});
