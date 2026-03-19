import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

      expect(body.logs).toHaveLength(2);
      expect(body.total).toBe(5);
      expect(body.page).toBe(1);
      expect(body.pages).toBe(3);
    });

    it("filters by level", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      await createTestLogEntry({ level: "INFO", message: "info" });
      await createTestLogEntry({ level: "ERROR", message: "error" });
      await createTestLogEntry({ level: "WARN", message: "warn" });
      await createTestLogEntry({ level: "DEBUG", message: "debug" });

      const response = await callRoute(GET, {
        url: "/api/system/logs",
        searchParams: { level: "ERROR,WARN" },
      });
      const body = await expectJson<{ logs: unknown[]; total: number }>(response, 200);

      expect(body.total).toBe(2);
    });

    it("filters by category", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      await createTestLogEntry({ message: "Server started successfully" });
      await createTestLogEntry({ message: "Database connection established" });
      await createTestLogEntry({ message: "server shutdown initiated" });

      const response = await callRoute(GET, {
        url: "/api/system/logs",
        searchParams: { search: "server" },
      });
      const body = await expectJson<{ logs: unknown[]; total: number }>(response, 200);

      expect(body.total).toBe(2);
    });

    it("returns second page", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      for (let i = 0; i < 5; i++) {
        await createTestLogEntry({ message: `log ${i}` });
      }

      const response = await callRoute(GET, {
        url: "/api/system/logs",
        searchParams: { limit: "2", page: "2" },
      });
      const body = await expectJson<{ logs: unknown[]; page: number }>(response, 200);

      expect(body.logs).toHaveLength(2);
      expect(body.page).toBe(2);
    });

    it("clamps limit to max 500", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      await createTestLogEntry({ message: "test" });

      const response = await callRoute(GET, {
        url: "/api/system/logs",
        searchParams: { limit: "9999" },
      });
      const body = await expectJson<{ logs: unknown[]; total: number }>(response, 200);

      // Should not error, just clamp
      expect(body.total).toBe(1);
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
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const response = await callRoute(SOURCES_GET, { url: "/api/system/logs/sources" });
      const body = await expectJson<{ sources: string[]; categories: string[] }>(response, 200);

      expect(body.sources).toEqual([]);
      expect(body.categories).toEqual(["BACKEND", "API", "DB"]);
    });

    it("returns distinct source values", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      await createTestLogEntry({ source: "scheduler" });
      await createTestLogEntry({ source: "sync-engine" });
      await createTestLogEntry({ source: "scheduler" }); // duplicate

      const response = await callRoute(SOURCES_GET, { url: "/api/system/logs/sources" });
      const body = await expectJson<{ sources: string[]; categories: string[] }>(response, 200);

      expect(body.sources).toHaveLength(2);
      expect(body.sources).toContain("scheduler");
      expect(body.sources).toContain("sync-engine");
      expect(body.categories).toEqual(["BACKEND", "API", "DB"]);
    });
  });
});
