import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, createTestUser } from "../../setup/test-helpers";

const mockTest = vi.hoisted(() => vi.fn());
const captured = vi.hoisted(() => [] as { apiKey: string; baseUrl: string }[]);

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/ai/provider", () => ({
  createProvider: (cfg: { apiKey: string; baseUrl: string }) => {
    captured.push(cfg);
    return { testConnection: mockTest };
  },
}));

import { POST } from "@/app/api/settings/ai/test/route";

/* eslint-disable @typescript-eslint/no-explicit-any */
beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  mockTest.mockReset();
  captured.length = 0;
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function login() {
  const user = await createTestUser();
  setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
  return user;
}

function post(body: unknown, ip: string) {
  return callRoute(POST, { method: "POST", body, headers: { "x-forwarded-for": ip } });
}

describe("POST /api/settings/ai/test", () => {
  it("401 when unauthenticated", async () => {
    await expectJson(await post({ provider: "openai-compatible", model: "m" }, "10.9.0.1"), 401);
  });

  it("returns ok on a successful connection", async () => {
    await login();
    mockTest.mockResolvedValue({ ok: true, model: "m" });
    const body = await expectJson<any>(await post({ provider: "openai-compatible", model: "m", apiKey: "k" }, "10.9.0.2"));
    expect(body.ok).toBe(true);
    expect(body.model).toBe("m");
  });

  it("returns the error on failure", async () => {
    await login();
    mockTest.mockResolvedValue({ ok: false, error: "unreachable" });
    const body = await expectJson<any>(await post({ provider: "openai-compatible", model: "m" }, "10.9.0.3"));
    expect(body.ok).toBe(false);
    expect(body.error).toBe("unreachable");
  });

  it("falls back to the saved key when a masked key is sent", async () => {
    const user = await login();
    await getTestPrisma().appSettings.create({ data: { userId: user.id, aiApiKey: "saved-key" } });
    mockTest.mockResolvedValue({ ok: true, model: "m" });
    await post({ provider: "openai-compatible", model: "m", apiKey: "••••••••" }, "10.9.0.4");
    expect(captured[captured.length - 1].apiKey).toBe("saved-key");
  });
});
