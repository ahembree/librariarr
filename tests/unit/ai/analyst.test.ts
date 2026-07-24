import { describe, it, expect, vi, beforeEach } from "vitest";

const mockChat = vi.hoisted(() => vi.fn());
const mockExecute = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/provider", () => ({
  createProvider: () => ({ chat: mockChat, testConnection: vi.fn() }),
}));
vi.mock("@/lib/ai/system-prompt", () => ({ buildSystemPrompt: () => "SYS" }));
vi.mock("@/lib/ai/tools", () => {
  const tool = {
    definition: { name: "get_breakdown", description: "d", parameters: {} },
    execute: mockExecute,
  };
  return {
    getAiTools: () => [tool],
    getAiToolMap: () => new Map([["get_breakdown", tool]]),
  };
});

import { runAnalyst } from "@/lib/ai/analyst";
import type { AiConfig, AiStreamEvent } from "@/lib/ai/types";

const config: AiConfig = { provider: "openai-compatible", baseUrl: "x", apiKey: "", model: "m" };

beforeEach(() => {
  mockChat.mockReset();
  mockExecute.mockReset();
});

describe("ai/analyst — runAnalyst", () => {
  it("runs a tool then returns the final answer and collected evidence", async () => {
    mockChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "1", name: "get_breakdown", arguments: { dimension: "resolution" } }],
      })
      .mockResolvedValueOnce({ content: "Final answer", toolCalls: [] });
    mockExecute.mockResolvedValue({
      data: { rows: [] },
      evidence: { tool: "get_breakdown", kind: "breakdown", title: "t", data: {} },
    });

    const events: AiStreamEvent[] = [];
    const result = await runAnalyst(
      { userId: "u", config, messages: [{ role: "user", content: "q" }] },
      (e) => events.push(e),
    );

    expect(result.answer).toBe("Final answer");
    expect(result.evidence).toHaveLength(1);
    expect(mockExecute).toHaveBeenCalledWith("u", { dimension: "resolution" });
    expect(events.some((e) => e.type === "tool" && e.tool === "get_breakdown")).toBe(true);
    expect(events.some((e) => e.type === "status")).toBe(true);
  });

  it("feeds an error result back for an unknown tool", async () => {
    mockChat
      .mockResolvedValueOnce({ content: "", toolCalls: [{ id: "1", name: "nope", arguments: {} }] })
      .mockResolvedValueOnce({ content: "answer", toolCalls: [] });

    const result = await runAnalyst(
      { userId: "u", config, messages: [{ role: "user", content: "q" }] },
      () => {},
    );

    expect(result.answer).toBe("answer");
    expect(mockExecute).not.toHaveBeenCalled();
    const secondCallMessages = mockChat.mock.calls[1][0] as { role: string; content: string }[];
    const toolMsg = secondCallMessages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("Unknown tool");
  });

  it("stops at the iteration cap and falls back gracefully", async () => {
    mockChat.mockResolvedValue({
      content: "",
      toolCalls: [{ id: "1", name: "get_breakdown", arguments: {} }],
    });
    mockExecute.mockResolvedValue({
      data: {},
      evidence: { tool: "get_breakdown", kind: "breakdown", title: "t", data: {} },
    });

    const result = await runAnalyst(
      { userId: "u", config, messages: [{ role: "user", content: "q" }] },
      () => {},
    );

    // 6 loop iterations + 1 tool-disabled fallback call.
    expect(mockChat).toHaveBeenCalledTimes(7);
    expect(result.answer.toLowerCase()).toContain("gathered the data");
  });
});
