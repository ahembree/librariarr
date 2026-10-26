/**
 * What POST /api/lifecycle/rules/run answers with, over mocked detection. The
 * route against the database is covered by tests/integration/lifecycle/rules-run.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mockRunDetection = vi.hoisted(() => vi.fn());
const mockPrisma = vi.hoisted(() => ({
  ruleSet: { findMany: vi.fn() },
  mediaServer: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(async () => ({ isLoggedIn: true, userId: "u1" })),
}));
vi.mock("@/lib/lifecycle/detect-matches", () => ({
  runDetection: mockRunDetection,
  syncCollectionsAfterDetection: vi.fn(),
}));
vi.mock("@/lib/lifecycle/processor", () => ({ scheduleActionsForRuleSet: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "@/app/api/lifecycle/rules/run/route";

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.ruleSet.findMany.mockResolvedValue([]);
  mockPrisma.mediaServer.findMany.mockResolvedValue([]);
});

describe("POST /api/lifecycle/rules/run", () => {
  it("answers with each evaluated rule set and its count, not the matched rows", async () => {
    const ruleSet = { id: "rs1", name: "Unwatched", type: "MUSIC" };
    const items = Array.from({ length: 5_000 }, (_, i) => ({ id: `t${i}`, title: `Track ${i}`, summary: "x".repeat(200) }));
    mockRunDetection.mockResolvedValue([{ ruleSet, items, count: items.length }]);

    const response = await POST(
      new NextRequest("http://localhost/api/lifecycle/rules/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullReEval: true }),
      }),
    );
    const text = await response.text();

    expect(JSON.parse(text)).toEqual({ ruleMatches: [{ ruleSet, count: 5_000 }], skipped: [] });
    expect(text.length).toBeLessThan(500);
  });
});
