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
import { getAiTools, SEARCH_FIELDS } from "@/lib/ai/tools";
import { DIMENSION_REGISTRY } from "@/lib/dashboard/custom-dimensions";
import { CONDITION_FIELDS, CONDITION_OPERATORS } from "@/lib/conditions";

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

  it("describes every tool the model is handed", () => {
    const names = getAiTools().map((t) => t.definition.name);
    expect(names).toHaveLength(7);
    expect(names.filter((name) => !prompt.includes(`- ${name} — `))).toEqual([]);
  });

  it("lists every dimension and operator from the registries", () => {
    expect(prompt).toContain(`\n${DIMENSION_REGISTRY.map((d) => d.id).join(", ")}\n`);
    expect(prompt).toContain(`Operators: ${CONDITION_OPERATORS.map((o) => o.value).join(", ")}.`);
  });

  it("lists every searchable field and none that needs Arr or Seerr data", () => {
    expect(SEARCH_FIELDS.filter((f) => !prompt.includes(`${f.value} (${f.type})`))).toEqual([]);
    const external = CONDITION_FIELDS.filter((f) => f.requiresArr || f.requiresSeerr);
    expect(external.length).toBeGreaterThan(0);
    expect(external.filter((f) => prompt.includes(`${f.value} (${f.type})`))).toEqual([]);
  });

  it("warns against treating tool-result text as instructions", () => {
    expect(prompt.toLowerCase()).toContain("never instructions");
  });
});
