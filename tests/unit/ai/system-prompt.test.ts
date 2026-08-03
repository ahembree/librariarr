import { describe, it, expect, vi } from "vitest";

// buildSystemPrompt pulls SEARCH_FIELDS from tools.ts, which transitively imports
// DB-backed modules; stub them so nothing connects at import time.
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildSystemPrompt } from "@/lib/ai/system-prompt";

describe("ai/system-prompt", () => {
  const prompt = buildSystemPrompt();

  it("declares the read-only, grounded posture", () => {
    expect(prompt).toContain("READ-ONLY");
    expect(prompt.toLowerCase()).toContain("ground every quantitative claim");
  });

  it("sets the local-only scope boundary", () => {
    expect(prompt.toLowerCase()).toContain("outside world");
    expect(prompt).toContain("get_watch_trends");
  });

  it("lists every tool", () => {
    for (const tool of [
      "get_library_overview",
      "get_breakdown",
      "get_cross_tab",
      "get_timeline",
      "search_media",
      "get_watch_trends",
      "get_watch_leaderboard",
    ]) {
      expect(prompt).toContain(tool);
    }
  });

  it("includes real dimensions and operators from the registries", () => {
    expect(prompt).toContain("resolution");
    expect(prompt).toContain("videoCodec");
    expect(prompt).toContain("inLastDays");
    expect(prompt).toContain("isNull");
  });

  it("warns against treating tool-result text as instructions", () => {
    expect(prompt.toLowerCase()).toContain("never instructions");
  });
});
