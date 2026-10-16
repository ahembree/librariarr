import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AxiosAdapter, InternalAxiosRequestConfig, AxiosResponse } from "axios";

// Real axios (so the client's interceptor runs) with every request routed to a
// test adapter instead of the network.
const { adapter, created } = vi.hoisted(() => ({
  adapter: vi.fn(),
  created: [] as Record<string, unknown>[],
}));

vi.mock("axios", async (importOriginal) => {
  const real = await importOriginal<typeof import("axios")>();
  const create = (config: Record<string, unknown>) => {
    created.push(config);
    return real.default.create({ ...config, adapter: adapter as unknown as AxiosAdapter });
  };
  return { ...real, default: { ...real.default, create } };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AxiosError } from "axios";
import { createProvider } from "@/lib/ai/provider";
import { IntegrationError } from "@/lib/integration-error";
import type { AiConfig } from "@/lib/ai/types";

const OPENAI: AiConfig = { provider: "openai-compatible", baseUrl: "http://llm/v1", apiKey: "", model: "m" };
const ANTHROPIC: AiConfig = { provider: "anthropic", baseUrl: "https://api.test", apiKey: "sk", model: "c" };

function respond(data: unknown) {
  adapter.mockImplementationOnce(async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => ({
    data,
    status: 200,
    statusText: "OK",
    headers: {},
    config,
  }));
}

function lastRequest() {
  const config = adapter.mock.calls[adapter.mock.calls.length - 1][0] as InternalAxiosRequestConfig;
  return { url: config.url, body: JSON.parse(String(config.data)), config };
}

beforeEach(() => {
  adapter.mockReset();
  created.length = 0;
});

describe("provider HTTP setup", () => {
  it("sends no Authorization header to a keyless OpenAI-compatible endpoint", () => {
    createProvider(OPENAI);
    expect(created[0].headers).toEqual({ "Content-Type": "application/json" });
    expect(created[0].baseURL).toBe("http://llm/v1");
  });

  it("sends a bearer key when one is configured, and Anthropic's own headers", () => {
    createProvider({ ...OPENAI, apiKey: "secret" });
    createProvider(ANTHROPIC);
    expect(created[0].headers).toMatchObject({ Authorization: "Bearer secret" });
    expect(created[1].headers).toMatchObject({ "x-api-key": "sk", "anthropic-version": "2023-06-01" });
  });

  it("turns an HTTP failure into an IntegrationError and reports it from testConnection", async () => {
    adapter.mockImplementation(async (config: InternalAxiosRequestConfig) => {
      throw new AxiosError("Request failed with status code 401", "ERR_BAD_REQUEST", config, null, {
        data: { error: "bad key" },
        status: 401,
        statusText: "Unauthorized",
        headers: {},
        config,
      });
    });
    const client = createProvider(OPENAI);
    await expect(client.chat([{ role: "user", content: "q" }], [])).rejects.toBeInstanceOf(IntegrationError);

    const result = await client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toEqual(expect.any(String));
    expect(lastRequest().config.timeout).toBe(30_000);

    const anthropic = await createProvider(ANTHROPIC).testConnection();
    expect(anthropic.ok).toBe(false);
  });

  it("passes a non-axios failure through unchanged and reports a non-Error as a generic failure", async () => {
    adapter.mockImplementationOnce(async () => {
      throw "boom";
    });
    expect(await createProvider(OPENAI).testConnection()).toEqual({ ok: false, error: "Connection failed" });

    adapter.mockImplementationOnce(async () => {
      throw "boom";
    });
    expect(await createProvider(ANTHROPIC).testConnection()).toEqual({ ok: false, error: "Connection failed" });
  });

  it("reports the model on a successful Anthropic test", async () => {
    respond({ content: [] });
    expect(await createProvider(ANTHROPIC).testConnection()).toEqual({ ok: true, model: "c" });
    expect(lastRequest().url).toBe("/v1/messages");
  });
});

describe("OpenAI-compatible message mapping and parsing", () => {
  it("omits tools when none are offered and maps every role", async () => {
    respond({ choices: [{ message: { content: "done" } }] });
    const result = await createProvider(OPENAI).chat(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "x", arguments: { a: 1 } }] },
        { role: "tool", toolCallId: "t1", name: "x", content: "{}" },
        { role: "assistant", content: "plain", toolCalls: [] },
      ],
      [],
    );
    expect(result).toEqual({ content: "done", toolCalls: [] });
    const { url, body } = lastRequest();
    expect(url).toBe("/chat/completions");
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: '{"a":1}' } }],
      },
      { role: "tool", tool_call_id: "t1", content: "{}" },
      { role: "assistant", content: "plain" },
    ]);
  });

  it("normalises odd tool-call shapes", async () => {
    respond({
      choices: [
        {
          message: {
            content: 42,
            tool_calls: [
              null,
              { function: { name: "a", arguments: { k: "v" } } },
              { id: "b", function: { name: "b", arguments: "" } },
              { id: "c", function: { name: "c", arguments: "[1" } },
              { id: "d", function: { name: "d", arguments: "5" } },
              { id: "e", function: { name: "e", arguments: 7 } },
              { id: "f", function: {} },
            ],
          },
        },
      ],
    });
    const result = await createProvider(OPENAI).chat([{ role: "user", content: "q" }], []);
    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([
      { id: "call_0", name: "a", arguments: { k: "v" } },
      { id: "b", name: "b", arguments: {} },
      { id: "c", name: "c", arguments: {} },
      { id: "d", name: "d", arguments: {} },
      { id: "e", name: "e", arguments: {} },
    ]);
  });

  it("handles a response with no choices", async () => {
    respond({});
    expect(await createProvider(OPENAI).chat([{ role: "user", content: "q" }], [])).toEqual({
      content: "",
      toolCalls: [],
    });
  });
});

describe("Anthropic message mapping and parsing", () => {
  it("omits system and tools when absent and handles odd content blocks", async () => {
    respond({
      content: [
        { type: "text", text: "a" },
        { type: "text" },
        { type: "tool_use", name: "t", input: "not-an-object" },
        { type: "tool_use", id: "x" },
        { type: "text", text: "b" },
      ],
    });
    const result = await createProvider(ANTHROPIC).chat(
      [
        { role: "user", content: "q" },
        { role: "assistant", content: "" },
        { role: "tool", toolCallId: "t1", name: "x", content: "r1" },
        { role: "user", content: "again" },
        { role: "tool", toolCallId: "t2", name: "x", content: "r2" },
      ],
      [],
    );
    expect(result).toEqual({ content: "ab", toolCalls: [{ id: "call_0", name: "t", arguments: {} }] });
    const { body } = lastRequest();
    expect(body.system).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r1" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "r2" }] },
    ]);
  });

  it("returns nothing for a response without a content array", async () => {
    respond({ content: "oops" });
    expect(await createProvider(ANTHROPIC).chat([{ role: "user", content: "q" }], [])).toEqual({
      content: "",
      toolCalls: [],
    });
  });
});
