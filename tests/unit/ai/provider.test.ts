import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPost = vi.hoisted(() => vi.fn());

vi.mock("axios", () => {
  const create = vi.fn(() => ({
    post: mockPost,
    interceptors: { response: { use: vi.fn() } },
  }));
  return {
    default: { create, isAxiosError: () => false },
    isAxiosError: () => false,
  };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createProvider } from "@/lib/ai/provider";
import type { AiConfig, AiMessage } from "@/lib/ai/types";

const OPENAI: AiConfig = {
  provider: "openai-compatible",
  baseUrl: "http://x/v1",
  apiKey: "k",
  model: "gpt-test",
};
const ANTHROPIC: AiConfig = {
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-ant",
  model: "claude-test",
};

beforeEach(() => mockPost.mockReset());

describe("ai/provider — OpenAI-compatible", () => {
  it("parses content and tool calls, and sends tools", async () => {
    mockPost.mockResolvedValue({
      data: {
        choices: [
          {
            message: {
              content: "hello",
              tool_calls: [
                { id: "c1", function: { name: "get_breakdown", arguments: '{"dimension":"resolution"}' } },
              ],
            },
          },
        ],
      },
    });

    const result = await createProvider(OPENAI).chat(
      [{ role: "user", content: "q" }],
      [{ name: "get_breakdown", description: "d", parameters: { type: "object" } }],
    );

    expect(result.content).toBe("hello");
    expect(result.toolCalls).toEqual([
      { id: "c1", name: "get_breakdown", arguments: { dimension: "resolution" } },
    ]);

    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe("/chat/completions");
    expect(body.model).toBe("gpt-test");
    expect(body.tools[0].function.name).toBe("get_breakdown");
    expect(body.tool_choice).toBe("auto");
  });

  it("tolerates malformed tool-call arguments", async () => {
    mockPost.mockResolvedValue({
      data: { choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name: "x", arguments: "not-valid-json" } }] } }] },
    });
    const result = await createProvider(OPENAI).chat([{ role: "user", content: "q" }], []);
    expect(result.toolCalls[0].arguments).toEqual({});
  });

  it("testConnection returns ok on success and error on failure", async () => {
    mockPost.mockResolvedValueOnce({ data: {} });
    expect(await createProvider(OPENAI).testConnection()).toEqual({ ok: true, model: "gpt-test" });
    mockPost.mockRejectedValueOnce(new Error("refused"));
    expect(await createProvider(OPENAI).testConnection()).toEqual({ ok: false, error: "refused" });
  });
});

describe("ai/provider — Anthropic", () => {
  it("parses text and tool_use blocks", async () => {
    mockPost.mockResolvedValue({
      data: {
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "get_cross_tab", input: { dimension1: "a", dimension2: "b" } },
        ],
      },
    });

    const result = await createProvider(ANTHROPIC).chat(
      [{ role: "user", content: "q" }],
      [{ name: "get_cross_tab", description: "d", parameters: { type: "object" } }],
    );

    expect(result.content).toBe("ok");
    expect(result.toolCalls).toEqual([
      { id: "t1", name: "get_cross_tab", arguments: { dimension1: "a", dimension2: "b" } },
    ]);

    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe("/v1/messages");
    expect(body.tools[0].input_schema).toEqual({ type: "object" });
  });

  it("maps system + merges consecutive tool results into one user turn", async () => {
    mockPost.mockResolvedValue({ data: { content: [{ type: "text", text: "done" }] } });

    const messages: AiMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "tc1", name: "x", arguments: {} }] },
      { role: "tool", toolCallId: "tc1", name: "x", content: "res1" },
      { role: "tool", toolCallId: "tc2", name: "y", content: "res2" },
    ];
    await createProvider(ANTHROPIC).chat(messages, []);

    const body = mockPost.mock.calls[0][1];
    expect(body.system).toBe("SYS");
    // user(text), assistant(tool_use), user([tool_result, tool_result])
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "q" }] });
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[1].content[0]).toEqual({ type: "tool_use", id: "tc1", name: "x", input: {} });
    expect(body.messages[2].role).toBe("user");
    expect(body.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "tc1", content: "res1" },
      { type: "tool_result", tool_use_id: "tc2", content: "res2" },
    ]);
  });
});
