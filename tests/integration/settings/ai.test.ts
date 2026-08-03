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

import { GET, PUT } from "@/app/api/settings/ai/route";

const MASK = "••••••••";

/* eslint-disable @typescript-eslint/no-explicit-any */
beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
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

describe("GET/PUT /api/settings/ai", () => {
  it("401 when unauthenticated", async () => {
    await expectJson(await callRoute(GET), 401);
  });

  it("returns defaults when nothing is saved", async () => {
    await login();
    const body = await expectJson<any>(await callRoute(GET));
    expect(body.enabled).toBe(false);
    expect(body.provider).toBe("openai-compatible");
    expect(body.apiKey).toBe("");
    expect(body.hasApiKey).toBe(false);
  });

  it("saves settings and masks the key on the way out", async () => {
    const user = await login();
    const res = await callRoute(PUT, {
      method: "PUT",
      body: { enabled: true, provider: "anthropic", baseUrl: "", apiKey: "secret", model: "claude-x" },
    });
    const body = await expectJson<any>(res);
    expect(body.enabled).toBe(true);
    expect(body.provider).toBe("anthropic");
    expect(body.model).toBe("claude-x");
    expect(body.apiKey).toBe(MASK);

    const got = await expectJson<any>(await callRoute(GET));
    expect(got.apiKey).toBe(MASK);
    expect(got.hasApiKey).toBe(true);

    // Re-saving with the mask must NOT overwrite the stored key.
    await callRoute(PUT, { method: "PUT", body: { baseUrl: "http://x", apiKey: MASK } });
    const raw = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
    expect(raw?.aiApiKey).toBe("secret");
    expect(raw?.aiBaseUrl).toBe("http://x");
  });

  it("clears the key with an empty string", async () => {
    const user = await login();
    await callRoute(PUT, { method: "PUT", body: { model: "m", apiKey: "k" } });
    await callRoute(PUT, { method: "PUT", body: { apiKey: "" } });
    const raw = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
    expect(raw?.aiApiKey).toBeNull();
  });

  it("rejects enabling without a model", async () => {
    await login();
    const body = await expectJson<any>(await callRoute(PUT, { method: "PUT", body: { enabled: true } }), 400);
    expect(body.error).toContain("model");
  });

  it("rejects an invalid provider", async () => {
    await login();
    await expectJson(await callRoute(PUT, { method: "PUT", body: { provider: "gemini" } }), 400);
  });
});
