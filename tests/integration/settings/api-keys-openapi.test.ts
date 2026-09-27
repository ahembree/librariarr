import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { gunzipSync } from "node:zlib";
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

  // The in-app Swagger viewer: behind a proxy that terminates TLS without
  // X-Forwarded-Proto an absolute URL read http:// and every Try it out
  // request from the https page was blocked as mixed content.
  it("gives the in-app viewer a relative server URL, and is never cached", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const res = await callRoute(GET, {
      url: "/api/settings/api-keys/openapi",
      headers: { "x-forwarded-host": "librariarr.example.com" },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBeNull();
    const doc = await expectJson<Doc>(res, 200);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: "/api/v1" }]);
    expect(doc.paths["/me"]).toBeDefined();
  });

  it("downloads as a file with ?download=1, built for the address the request arrived on", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const res = await callRoute(GET, {
      url: "/api/settings/api-keys/openapi?download=1",
      headers: { "x-forwarded-host": "librariarr.example.com", "x-forwarded-proto": "https" },
    });
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="librariarr-openapi.json"');
    const doc = await expectJson<Doc>(res, 200);
    expect(doc.servers).toEqual([{ url: "https://librariarr.example.com/api/v1" }]);
  });

  it("is compressed for a client that accepts gzip", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const res = await callRoute(GET, {
      url: "/api/settings/api-keys/openapi",
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const doc = JSON.parse(gunzipSync(new Uint8Array(await res.arrayBuffer())).toString("utf8")) as Doc;
    expect(doc.openapi).toBe("3.1.0");
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
    // Tooling reads this one; it keeps the absolute address.
    expect(doc.servers[0].url).toMatch(/^https?:\/\/.+\/api\/v1$/);
  });
});
