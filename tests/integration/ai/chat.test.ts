import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, expectJson, expectStreamResult, createTestUser } from "../../setup/test-helpers";

const mockRunAnalyst = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/ai/analyst", () => ({ runAnalyst: mockRunAnalyst }));

import { POST } from "@/app/api/ai/chat/route";

/* eslint-disable @typescript-eslint/no-explicit-any */
beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  mockRunAnalyst.mockReset();
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

function chat(body: unknown, ip: string) {
  return callRoute(POST, { method: "POST", body, headers: { "x-forwarded-for": ip } });
}

const MSG = { messages: [{ role: "user", content: "hi" }] };

describe("POST /api/ai/chat", () => {
  it("401 when unauthenticated", async () => {
    expect(await expectJson(await chat(MSG, "10.8.0.1"), 401)).toEqual({ error: "Unauthorized" });
    expect(mockRunAnalyst).not.toHaveBeenCalled();
  });

  it("400 when the assistant is disabled", async () => {
    await login();
    const body = await expectJson<any>(await chat(MSG, "10.8.0.2"), 400);
    expect(body.error).toBe("The AI assistant is disabled. Enable it under Settings → AI.");
    expect(mockRunAnalyst).not.toHaveBeenCalled();
  });

  it("400 when enabled but not fully configured", async () => {
    const user = await login();
    await getTestPrisma().appSettings.create({ data: { userId: user.id, aiEnabled: true } });
    const body = await expectJson<any>(await chat(MSG, "10.8.0.3"), 400);
    expect(body.error).toBe("The AI assistant isn't fully configured — set a model under Settings → AI.");
    expect(mockRunAnalyst).not.toHaveBeenCalled();
  });

  it("400 on empty messages", async () => {
    const user = await login();
    await getTestPrisma().appSettings.create({ data: { userId: user.id, aiEnabled: true, aiModel: "llama3.1:8b" } });
    const body = await expectJson<{ details: string[] }>(await chat({ messages: [] }, "10.8.0.4"), 400);
    expect(body.details).toEqual(["messages: At least one message is required"]);
    expect(mockRunAnalyst).not.toHaveBeenCalled();
  });

  it("streams status events and the final result when configured", async () => {
    const user = await login();
    await getTestPrisma().appSettings.create({
      data: { userId: user.id, aiEnabled: true, aiModel: "gpt-4o-mini", aiProvider: "openai-compatible" },
    });
    const evidence = [{ tool: "get_breakdown", kind: "breakdown", title: "Resolution", data: { rows: [] } }];
    mockRunAnalyst.mockImplementation(async (_input: unknown, emit: (e: unknown) => void) => {
      emit({ type: "status", label: "working" });
      return { answer: "hello", evidence };
    });

    const res = await chat(MSG, "10.8.0.5");
    const { result, events } = await expectStreamResult<{ answer: string; evidence: unknown[] }>(res);
    expect(result).toEqual({ answer: "hello", evidence });
    expect(events).toEqual([
      { type: "status", label: "working" },
      { type: "result", result: { answer: "hello", evidence } },
    ]);
    // The stored settings resolve to the provider's default endpoint, and the
    // request's messages reach the analyst unchanged.
    expect(mockRunAnalyst).toHaveBeenCalledTimes(1);
    expect(mockRunAnalyst.mock.calls[0][0]).toEqual({
      userId: user.id,
      config: { provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
      messages: MSG.messages,
    });
  });
});
