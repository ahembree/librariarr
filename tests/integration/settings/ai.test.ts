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
  setMockSession({ isLoggedIn: true, userId: user.id});
  return user;
}

describe("GET/PUT /api/settings/ai", () => {
  it("401 when unauthenticated", async () => {
    await expectJson(await callRoute(GET), 401);
  });

  it("returns defaults when nothing is saved", async () => {
    await login();
    const body = await expectJson<any>(await callRoute(GET));
    expect(body).toEqual({
      enabled: false,
      provider: "openai-compatible",
      baseUrl: "",
      model: "",
      apiKey: "",
      hasApiKey: false,
    });
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
    await expectJson(await callRoute(PUT, { method: "PUT", body: { baseUrl: "", apiKey: MASK, model: "claude-y" } }));
    const raw = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
    expect(raw?.aiApiKey).toBe("secret");
    expect(raw?.aiModel).toBe("claude-y");
  });

  // The next chat sends the stored key to the saved base URL, so moving the URL
  // with the key kept is the stored-key-to-new-URL case every integration guards.
  it("asks a stale session to confirm it's them before keeping the saved key on a new base URL", async () => {
    const user = await createTestUser();
    await getTestPrisma().appSettings.create({
      data: { userId: user.id, aiApiKey: "secret", aiBaseUrl: "https://api.openai.com/v1", aiModel: "m" },
    });
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() - 24 * 60 * 60 * 1000 });

    for (const body of [{ baseUrl: "https://attacker.example/v1" }, { baseUrl: "https://attacker.example/v1", apiKey: MASK }]) {
      const refusal = await expectJson<{ code: string }>(await callRoute(PUT, { method: "PUT", body }), 403);
      expect(refusal.code).toBe("reauth_required");
    }
    const raw = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
    expect(raw?.aiBaseUrl).toBe("https://api.openai.com/v1");
    expect(raw?.aiApiKey).toBe("secret");

    // A key of the caller's own goes with the new URL; so does a recent sign-in.
    await expectJson(await callRoute(PUT, { method: "PUT", body: { baseUrl: "https://other.example/v1", apiKey: "new-key" } }), 200);
    setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: Date.now() });
    await expectJson(await callRoute(PUT, { method: "PUT", body: { baseUrl: "https://third.example/v1", apiKey: MASK } }), 200);
    const saved = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
    expect(saved?.aiBaseUrl).toBe("https://third.example/v1");
    expect(saved?.aiApiKey).toBe("new-key");
  });

  it("clears the key with an empty string", async () => {
    const user = await login();
    await expectJson(await callRoute(PUT, { method: "PUT", body: { model: "m", apiKey: "k" } }));
    expect((await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } }))?.aiApiKey).toBe("k");
    const body = await expectJson<any>(await callRoute(PUT, { method: "PUT", body: { apiKey: "" } }));
    expect(body.hasApiKey).toBe(false);
    const raw = await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } });
    expect(raw?.aiApiKey).toBeNull();
  });

  it("rejects enabling without a model", async () => {
    const user = await login();
    const body = await expectJson<any>(await callRoute(PUT, { method: "PUT", body: { enabled: true } }), 400);
    expect(body.error).toBe("Set a model before enabling the AI assistant.");
    expect(await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } })).toBeNull();
  });

  it("rejects an invalid provider", async () => {
    const user = await login();
    const body = await expectJson<any>(await callRoute(PUT, { method: "PUT", body: { provider: "gemini" } }), 400);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toHaveLength(1);
    expect(body.details[0]).toMatch(/^provider: /);
    expect(await getTestPrisma().appSettings.findUnique({ where: { userId: user.id } })).toBeNull();
  });
});
