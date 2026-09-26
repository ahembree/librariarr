import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser, createTestApiKey } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/settings/api-keys/openapi/route";
import { GET as v1GET } from "@/app/api/v1/openapi.json/route";

type Doc = { openapi: string; servers: Array<{ url: string }>; paths: Record<string, unknown> };

describe("the OpenAPI document", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("is cookie-session only on the settings route", async () => {
    await expectJson(await callRoute(GET), 401);
  });

  it("is built for the address the request arrived on, and never cached", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const res = await callRoute(GET, {
      url: "/api/settings/api-keys/openapi",
      headers: { "x-forwarded-host": "librariarr.example.com", "x-forwarded-proto": "https" },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBeNull();
    const doc = await expectJson<Doc>(res, 200);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: "https://librariarr.example.com/api/v1" }]);
    expect(doc.paths["/me"]).toBeDefined();
  });

  it("downloads as a file with ?download=1", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const res = await callRoute(GET, { url: "/api/settings/api-keys/openapi?download=1" });
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="librariarr-openapi.json"');
    await expectJson<Doc>(res, 200);
  });

  it("is served to any valid key under /api/v1, and describes itself", async () => {
    const user = await createTestUser();
    const { key } = await createTestApiKey(user.id, { scopes: ["system:read"] });
    await expectJson(await callRoute(v1GET), 401);
    const doc = await expectJson<Doc>(
      await callRoute(v1GET, { url: "/api/v1/openapi.json", headers: { authorization: `Bearer ${key}` } }),
      200,
    );
    expect(doc.paths["/openapi.json"]).toBeDefined();
  });
});
