import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET, PUT } from "@/app/api/settings/delete-ceiling/route";

const ROUTE_URL = "/api/settings/delete-ceiling";

async function put(body: unknown) {
  return callRoute(PUT, { url: ROUTE_URL, method: "PUT", body });
}

describe("/api/settings/delete-ceiling", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  describe("GET", () => {
    it("returns 401 without auth", async () => {
      await expectJson(await GET(), 401);
    });

    it("returns null (unlimited) when no settings row exists", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      const body = await expectJson<{ maxAutoDeleteItems: number | null }>(await GET(), 200);
      expect(body).toEqual({ maxAutoDeleteItems: null });
    });

    it("returns the stored ceiling and nothing else from the settings row", async () => {
      const user = await createTestUser();
      await getTestPrisma().appSettings.create({
        data: { userId: user.id, maxAutoDeleteItems: 25, backupEncryptionPassword: "secret" },
      });
      setMockSession({ userId: user.id, isLoggedIn: true });
      const body = await expectJson<Record<string, unknown>>(await GET(), 200);
      expect(body).toEqual({ maxAutoDeleteItems: 25 });
    });
  });

  describe("PUT", () => {
    it("returns 401 without auth", async () => {
      await expectJson(await put({ maxAutoDeleteItems: 5 }), 401);
    });

    it("creates the settings row with the ceiling", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      const body = await expectJson<{ maxAutoDeleteItems: number }>(
        await put({ maxAutoDeleteItems: 10 }),
        200,
      );
      expect(body.maxAutoDeleteItems).toBe(10);
      const row = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
      expect(row?.maxAutoDeleteItems).toBe(10);
    });

    it("clears the ceiling with an explicit null", async () => {
      const user = await createTestUser();
      await getTestPrisma().appSettings.create({ data: { userId: user.id, maxAutoDeleteItems: 3 } });
      setMockSession({ userId: user.id, isLoggedIn: true });
      const body = await expectJson<{ maxAutoDeleteItems: null }>(
        await put({ maxAutoDeleteItems: null }),
        200,
      );
      expect(body.maxAutoDeleteItems).toBeNull();
      const row = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
      expect(row?.maxAutoDeleteItems).toBeNull();
    });

    it.each([
      ["zero", { maxAutoDeleteItems: 0 }],
      ["negative", { maxAutoDeleteItems: -1 }],
      ["fractional", { maxAutoDeleteItems: 1.5 }],
      ["too large", { maxAutoDeleteItems: 1_000_001 }],
      ["a string", { maxAutoDeleteItems: "10" }],
      ["missing", {}],
    ])("rejects a %s value with 400 and writes nothing", async (_label, body) => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      const res = await put(body);
      const json = await expectJson<{ error: string; details: string[] }>(res, 400);
      expect(json.error).toBe("Validation failed");
      expect(json.details).toHaveLength(1);
      expect(json.details[0]).toMatch(/^maxAutoDeleteItems: /);
      expect(await getTestPrisma().appSettings.count()).toBe(0);
    });

    // 0 almost certainly means "off": the form is told how to say that.
    it("tells a zero apart from an empty field", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      const json = await expectJson<{ details: string[] }>(await put({ maxAutoDeleteItems: 0 }), 400);
      expect(json.details).toEqual([
        "maxAutoDeleteItems: The limit must be at least 1 — leave it empty to disable it",
      ]);
    });

    it("accepts the upper bound", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      await expectJson(await put({ maxAutoDeleteItems: 1_000_000 }), 200);
      const row = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
      expect(row?.maxAutoDeleteItems).toBe(1_000_000);
    });

    it("rejects malformed JSON", async () => {
      const user = await createTestUser();
      setMockSession({ userId: user.id, isLoggedIn: true });
      const { NextRequest } = await import("next/server");
      const req = new NextRequest("http://localhost" + ROUTE_URL, {
        method: "PUT",
        body: "{not json",
        headers: { "content-type": "application/json" },
      });
      const json = await expectJson<{ error: string }>(await PUT(req), 400);
      expect(json.error).toBe("Invalid JSON in request body");
    });
  });
});
