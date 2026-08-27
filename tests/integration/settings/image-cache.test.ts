import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
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

import { GET, PUT, DELETE } from "@/app/api/settings/image-cache/route";

describe("GET /api/settings/image-cache", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(GET);
    await expectJson(res, 401);
  });

  it("returns cache stats", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    mockGetImageCacheStats.mockResolvedValue({ fileCount: 42, totalSize: 1048576 });

    const res = await callRoute(GET);
    const body = await expectJson<{ fileCount: number; totalSize: number }>(res);
    expect(body.fileCount).toBe(42);
    expect(body.totalSize).toBe(1048576);
    expect(mockGetImageCacheStats).toHaveBeenCalledOnce();
  });

  it("defaults prewarmArtwork to true when no settings row exists", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    mockGetImageCacheStats.mockResolvedValue({ fileCount: 0, totalSize: 0 });

    const body = await expectJson<{ prewarmArtwork: boolean }>(await callRoute(GET));
    expect(body.prewarmArtwork).toBe(true);
  });

  it("reflects a saved prewarmArtwork value", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    mockGetImageCacheStats.mockResolvedValue({ fileCount: 0, totalSize: 0 });
    await getTestPrisma().appSettings.create({
      data: { userId: user.id, prewarmArtwork: false },
    });

    const body = await expectJson<{ prewarmArtwork: boolean }>(await callRoute(GET));
    expect(body.prewarmArtwork).toBe(false);
  });
});

describe("PUT /api/settings/image-cache", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(PUT, { method: "PUT", body: { prewarmArtwork: false } });
    await expectJson(res, 401);
  });

  it("rejects a non-boolean value", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const res = await callRoute(PUT, { method: "PUT", body: { prewarmArtwork: "yes" } });
    await expectJson(res, 400);
  });

  it("creates the settings row on first save", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    const body = await expectJson<{ prewarmArtwork: boolean }>(
      await callRoute(PUT, { method: "PUT", body: { prewarmArtwork: false } }),
    );
    expect(body.prewarmArtwork).toBe(false);

    const saved = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
    expect(saved?.prewarmArtwork).toBe(false);
  });

  it("updates an existing settings row without disturbing other fields", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
    await getTestPrisma().appSettings.create({
      data: { userId: user.id, prewarmArtwork: false, accentColor: "emerald" },
    });

    await callRoute(PUT, { method: "PUT", body: { prewarmArtwork: true } });

    const saved = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
    expect(saved?.prewarmArtwork).toBe(true);
    expect(saved?.accentColor).toBe("emerald");
  });
});

describe("DELETE /api/settings/image-cache", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await callRoute(DELETE, { method: "DELETE" });
    await expectJson(res, 401);
  });

  it("clears cache successfully", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    mockClearImageCache.mockResolvedValue(undefined);

    const res = await callRoute(DELETE, { method: "DELETE" });
    const body = await expectJson<{ success: boolean }>(res);
    expect(body.success).toBe(true);
    expect(mockClearImageCache).toHaveBeenCalledOnce();
  });

  it("returns 500 when clearing fails", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });

    mockClearImageCache.mockRejectedValue(new Error("disk error"));

    const res = await callRoute(DELETE, { method: "DELETE" });
    const body = await expectJson<{ error: string }>(res, 500);
    expect(body.error).toBe("Failed to clear image cache");
  });
});
