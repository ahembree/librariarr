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
  setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
  return user;
}

function chat(body: unknown, ip: string) {
  return callRoute(POST, { method: "POST", body, headers: { "x-forwarded-for": ip } });
}

const MSG = { messages: [{ role: "user", content: "hi" }] };

describe("POST /api/ai/chat", () => {
  it("401 when unauthenticated", async () => {
    await expectJson(await chat(MSG, "10.8.0.1"), 401);
  });

  it("400 when the assistant is disabled", async () => {
    await login();
    const body = await expectJson<any>(await chat(MSG, "10.8.0.2"), 400);
    expect(body.error.toLowerCase()).toContain("disabled");
  });

  it("400 when enabled but not fully configured", async () => {
    const user = await login();
    await getTestPrisma().appSettings.create({ data: { userId: user.id, aiEnabled: true } });
    const body = await expectJson<any>(await chat(MSG, "10.8.0.3"), 400);
    expect(body.error.toLowerCase()).toContain("configured");
  });

  it("400 on empty messages", async () => {
    const user = await login();
    await getTestPrisma().appSettings.create({ data: { userId: user.id, aiEnabled: true, aiModel: "m" } });
    await expectJson(await chat({ messages: [] }, "10.8.0.4"), 400);
  });

  it("streams status events and the final result when configured", async () => {
    const user = await login();
    await getTestPrisma().appSettings.create({
      data: { userId: user.id, aiEnabled: true, aiModel: "m", aiProvider: "openai-compatible" },
    });
    mockRunAnalyst.mockImplementation(async (_input: unknown, emit: (e: unknown) => void) => {
      emit({ type: "status", label: "working" });
      return { answer: "hello", evidence: [{ tool: "get_breakdown", kind: "breakdown", title: "t", data: {} }] };
    });

    const res = await chat(MSG, "10.8.0.5");
    const { result, events } = await expectStreamResult<{ answer: string; evidence: unknown[] }>(res);
    expect(result.answer).toBe("hello");
    expect(result.evidence).toHaveLength(1);
    expect(events.some((e) => e.type === "status")).toBe(true);
    expect(mockRunAnalyst).toHaveBeenCalled();
  });
});
