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

const config: AiConfig = { provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", apiKey: "", model: "llama3.1:8b" };

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
    const evidence = { tool: "get_breakdown", kind: "breakdown", title: "Resolution distribution", data: { rows: [] } };
    mockExecute.mockResolvedValue({ data: { rows: [{ value: "4K", count: 3 }] }, evidence });

    const events: AiStreamEvent[] = [];
    const result = await runAnalyst(
      { userId: "u", config, messages: [{ role: "user", content: "q" }] },
      (e) => events.push(e),
    );

    expect(result).toEqual({ answer: "Final answer", evidence: [evidence] });
    expect(mockExecute).toHaveBeenCalledWith("u", { dimension: "resolution" });
    expect(events).toEqual([
      { type: "status", label: "Analyzing your question" },
      { type: "tool", tool: "get_breakdown", label: "Computing a distribution" },
      { type: "status", label: "Reviewing the results" },
    ]);
    // The tool's result goes back to the model as the answer to its call.
    const secondCallMessages = mockChat.mock.calls[1][0] as { role: string; toolCallId?: string; content: string }[];
    expect(secondCallMessages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "1",
      name: "get_breakdown",
      content: JSON.stringify({ rows: [{ value: "4K", count: 3 }] }),
    });
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
    expect(toolMsg?.content).toBe(JSON.stringify({ error: 'Unknown tool "nope".' }));
  });

  it("feeds a tool's thrown error back to the model instead of failing the run", async () => {
    mockChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "1", name: "get_breakdown", arguments: { dimension: "resolution" } }],
      })
      .mockResolvedValueOnce({ content: "answer", toolCalls: [] });
    mockExecute.mockRejectedValue(new Error("database unavailable"));

    const result = await runAnalyst(
      { userId: "u", config, messages: [{ role: "user", content: "q" }] },
      () => {},
    );

    expect(result).toEqual({ answer: "answer", evidence: [] });
    const secondCallMessages = mockChat.mock.calls[1][0] as { role: string; content: string }[];
    expect(secondCallMessages.find((m) => m.role === "tool")?.content).toBe(
      JSON.stringify({ error: "database unavailable" }),
    );
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
    expect(mockChat.mock.calls[6][1]).toEqual([]);
    expect(mockExecute).toHaveBeenCalledTimes(6);
    // The fallback call answered with nothing either, so the canned summary
    // points at the evidence that was gathered.
    expect(result.answer).toBe(
      "I gathered the data but couldn't compose a written summary — see the results below.",
    );
    expect(result.evidence).toHaveLength(6);
  });
});
