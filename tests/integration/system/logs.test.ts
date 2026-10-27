import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestLogEntry,
} from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import route handlers AFTER mocks
import { GET } from "@/app/api/system/logs/route";
import { GET as SOURCES_GET } from "@/app/api/system/logs/sources/route";

describe("System logs endpoints", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // ----- GET /api/system/logs -----

  describe("GET /api/system/logs", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(GET, { url: "/api/system/logs" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty logs when none exist", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(GET, { url: "/api/system/logs" });
      const body = await expectJson<{
        logs: unknown[];
        total: number;
        page: number;
        pages: number;
      }>(response, 200);

      expect(body.logs).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.page).toBe(1);
      expect(body.pages).toBe(0);
    });

    it("returns paginated log entries", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      // Create 5 log entries
      for (let i = 0; i < 5; i++) {
        await createTestLogEntry({ message: `log message ${i}`, source: "test" });
      }

      const response = await callRoute(GET, {
        url: "/api/system/logs",
        searchParams: { limit: "2", page: "1" },
      });
      const body = await expectJson<{
        logs: { message: string }[];
        total: number;
        page: number;
        pages: number;
      }>(response, 200);

      // Newest first.
      expect(body.logs.map((l) => l.message)).toEqual(["log message 4", "log message 3"]);
      expect(body.total).toBe(5);
      expect(body.page).toBe(1);
      expect(body.pages).toBe(3);
    });

    it("filters by level", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      await createTestLogEntry({ level: "INFO", message: "info msg" });
      await createTestLogEntry({ level: "ERROR", message: "error msg" });
      await createTestLogEntry({ level: "WARN", message: "warn msg" });

      const response = await callRoute(GET, {
        url: "/api/system/logs",
        searchParams: { level: "ERROR" },
      });
      const body = await expectJson<{ logs: { level: string; message: string }[]; total: number }>(
        response,
        200
      );

      expect(body.total).toBe(1);
      expect(body.logs[0].level).toBe("ERROR");
      expect(body.logs[0].message).toBe("error msg");
    });

    it("filters by multiple levels", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      await createTestLogEntry({ level: "INFO", message: "info" });
      await createTestLogEntry({ level: "ERROR", message: "error" });
      await createTestLogEntry({ level: "WARN", message: "warn" });
      await createTestLogEntry({ level: "DEBUG", message: "debug" });

      const response = await callRoute(GET, {
        url: "/api/system/logs",
        searchParams: { level: "ERROR,WARN" },
      });
      const body = await expectJson<{ logs: { level: string }[]; total: number }>(response, 200);

      expect(body.total).toBe(2);
      expect(body.logs.map((l) => l.level).sort()).toEqual(["ERROR", "WARN"]);
    });

    it("filters by category", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      await createTestLogEntry({ category: "API", message: "api msg" });
      await createTestLogEntry({ category: "BACKEND", message: "backend msg" });

      const response = await callRoute(GET, {
        url: "/api/system/logs",
        searchParams: { category: "API" },
      });
      const body = await expectJson<{ logs: { category: string }[]; total: number }>(
        response,
        200
      );

      expect(body.total).toBe(1);
      expect(body.logs[0].category).toBe("API");
    });

    it("filters by source", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      await createTestLogEntry({ source: "sync-engine", message: "sync msg" });
      await createTestLogEntry({ source: "scheduler", message: "schedule msg" });

      const response = await callRoute(GET, {
        url: "/api/system/logs",
        searchParams: { source: "sync-engine" },
      });
      const body = await expectJson<{ logs: { source: string }[]; total: number }>(response, 200);

      expect(body.total).toBe(1);
      expect(body.logs[0].source).toBe("sync-engine");
    });

    it("filters by search text (case insensitive)", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      await createTestLogEntry({ message: "Server started successfully" });
      await createTestLogEntry({ message: "Database connection established" });
      await createTestLogEntry({ message: "server shutdown initiated" });

      const response = await callRoute(GET, {
        url: "/api/system/logs",
        searchParams: { search: "server" },
      });
      const body = await expectJson<{ logs: { message: string }[]; total: number }>(response, 200);

      expect(body.total).toBe(2);
      expect(body.logs.map((l) => l.message).sort()).toEqual([
        "Server started successfully",
        "server shutdown initiated",
      ]);
    });

    it("searches for % and _ literally, not as wildcards", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      await createTestLogEntry({ message: "Backfill 100% complete" });
      await createTestLogEntry({ message: "Database connection established" });
      await createTestLogEntry({ message: "Synced library_42" });

      const percent = await expectJson<{ logs: { message: string }[]; total: number }>(
        await callRoute(GET, { url: "/api/system/logs", searchParams: { search: "%" } }),
        200
      );
      expect(percent.logs.map((l) => l.message)).toEqual(["Backfill 100% complete"]);

      const underscore = await expectJson<{ logs: { message: string }[]; total: number }>(
        await callRoute(GET, { url: "/api/system/logs", searchParams: { search: "y_4" } }),
        200
      );
      expect(underscore.logs.map((l) => l.message)).toEqual(["Synced library_42"]);
    });

    it("returns second page", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      for (let i = 0; i < 5; i++) {
        await createTestLogEntry({ message: `log ${i}` });
      }

      const response = await callRoute(GET, {
        url: "/api/system/logs",
        searchParams: { limit: "2", page: "2" },
      });
      const body = await expectJson<{ logs: { message: string }[]; page: number }>(response, 200);

      expect(body.logs.map((l) => l.message)).toEqual(["log 2", "log 1"]);
      expect(body.page).toBe(2);
    });

    it("clamps limit to max 500", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      await getTestPrisma().logEntry.createMany({
        data: Array.from({ length: 501 }, (_, i) => ({
          level: "INFO" as const,
          category: "BACKEND" as const,
          source: "test",
          message: `log ${i}`,
        })),
      });

      const response = await callRoute(GET, {
        url: "/api/system/logs",
        searchParams: { limit: "9999" },
      });
      const body = await expectJson<{ logs: unknown[]; total: number; pages: number }>(response, 200);

      // Clamped to 500 a page rather than answering with all 501.
      expect(body.logs).toHaveLength(500);
      expect(body.total).toBe(501);
      expect(body.pages).toBe(2);
    });

    it("says whether another page follows", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      for (let i = 0; i < 3; i++) await createTestLogEntry({ message: `log ${i}` });

      const page = (p: string) =>
        callRoute(GET, { url: "/api/system/logs", searchParams: { limit: "2", page: p } });
      expect((await expectJson<{ hasMore: boolean }>(await page("1"))).hasMore).toBe(true);
      expect((await expectJson<{ hasMore: boolean }>(await page("2"))).hasMore).toBe(false);
    });

    it("skips the total with count=false and still pages the same rows", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      // Distinct timestamps, so both reads order the rows the same way.
      const base = Date.now() - 60_000;
      await getTestPrisma().logEntry.createMany({
        data: [
          ...Array.from({ length: 5 }, (_, i) => ({
            level: "INFO" as const,
            category: "BACKEND" as const,
            source: "test",
            message: `log ${i}`,
            createdAt: new Date(base + i * 1000),
          })),
          { level: "INFO" as const, category: "BACKEND" as const, source: "elsewhere", message: "other" },
        ],
      });

      type Body = { logs: { message: string }[]; total: number | null; pages: number | null; page: number; hasMore: boolean };
      const read = (searchParams: Record<string, string>) =>
        callRoute(GET, { url: "/api/system/logs", searchParams: { source: "test", limit: "2", ...searchParams } });

      const counted = await expectJson<Body>(await read({ page: "2" }));
      const uncounted = await expectJson<Body>(await read({ page: "2", count: "false" }));
      expect(uncounted.logs).toEqual(counted.logs);
      expect(uncounted).toMatchObject({ total: null, pages: null, page: 2, hasMore: true });
      expect(counted).toMatchObject({ total: 5, pages: 3, hasMore: true });

      const last = await expectJson<Body>(await read({ page: "3", count: "false" }));
      expect(last.logs.map((l) => l.message)).toEqual(["log 0"]);
      expect(last.hasMore).toBe(false);
    });
  });

  // ----- GET /api/system/logs/sources -----

  describe("GET /api/system/logs/sources", () => {
    it("returns 401 without auth", async () => {
      const response = await callRoute(SOURCES_GET, { url: "/api/system/logs/sources" });
      const body = await expectJson<{ error: string }>(response, 401);
      expect(body.error).toBe("Unauthorized");
    });

    it("returns empty sources when no logs exist", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const response = await callRoute(SOURCES_GET, { url: "/api/system/logs/sources" });
      const body = await expectJson<{ sources: string[]; categories: string[] }>(response, 200);

      expect(body.sources).toEqual([]);
      expect(body.categories).toEqual(["BACKEND", "API", "DB"]);
    });

    it("returns distinct source values", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      await createTestLogEntry({ source: "scheduler" });
      await createTestLogEntry({ source: "sync-engine" });
      await createTestLogEntry({ source: "scheduler" }); // duplicate

      const response = await callRoute(SOURCES_GET, { url: "/api/system/logs/sources" });
      const body = await expectJson<{ sources: string[]; categories: string[] }>(response, 200);

      // Each source once, alphabetically.
      expect(body.sources).toEqual(["scheduler", "sync-engine"]);
      expect(body.categories).toEqual(["BACKEND", "API", "DB"]);
    });

    it("lists every source of a large log once, in order", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });

      const sources = Array.from({ length: 12 }, (_, i) => `source-${String(i).padStart(2, "0")}`);
      await getTestPrisma().logEntry.createMany({
        data: Array.from({ length: 600 }, (_, i) => ({
          level: "INFO" as const,
          category: "BACKEND" as const,
          source: sources[(i * 7) % sources.length],
          message: `log ${i}`,
        })),
      });

      const body = await expectJson<{ sources: string[] }>(
        await callRoute(SOURCES_GET, { url: "/api/system/logs/sources" }),
      );
      expect(body.sources).toEqual(sources);
    });
  });
});
