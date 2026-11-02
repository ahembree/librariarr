import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

const mockGetImageCacheStats = vi.fn();
const mockClearImageCache = vi.fn();

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/image-cache/image-cache", () => ({
  getImageCacheStats: (...args: unknown[]) => mockGetImageCacheStats(...args),
  clearImageCache: (...args: unknown[]) => mockClearImageCache(...args),
}));

import { GET, DELETE } from "@/app/api/settings/image-cache/route";

describe("GET /api/settings/image-cache", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    // mockReset: a resolved or rejected value set by one test must not
    // answer the next one's call.
    mockGetImageCacheStats.mockReset();
    mockClearImageCache.mockReset();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
    expect(mockGetImageCacheStats).not.toHaveBeenCalled();
  });

  it("returns cache stats", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    mockGetImageCacheStats.mockResolvedValue({ fileCount: 42, totalSize: 1048576 });

    const res = await callRoute(GET);
    const body = await expectJson<{ fileCount: number; totalSize: number }>(res);
    expect(body).toEqual({ fileCount: 42, totalSize: 1048576 });
    expect(mockGetImageCacheStats).toHaveBeenCalledOnce();
  });
});

describe("DELETE /api/settings/image-cache", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    // mockReset: a resolved or rejected value set by one test must not
    // answer the next one's call.
    mockGetImageCacheStats.mockReset();
    mockClearImageCache.mockReset();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(DELETE, { method: "DELETE" });
    await expectJson(res, 401);
    expect(mockClearImageCache).not.toHaveBeenCalled();
  });

  it("clears cache successfully", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    mockClearImageCache.mockResolvedValue(undefined);

    const res = await callRoute(DELETE, { method: "DELETE" });
    const body = await expectJson<{ success: boolean }>(res);
    expect(body).toEqual({ success: true });
    expect(mockClearImageCache).toHaveBeenCalledOnce();
  });

  it("returns 500 when clearing fails", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id});

    mockClearImageCache.mockRejectedValue(new Error("disk error"));

    const res = await callRoute(DELETE, { method: "DELETE" });
    const body = await expectJson<{ error: string }>(res, 500);
    expect(body.error).toBe("Failed to clear image cache");
  });
});
