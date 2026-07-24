import axios, { type AxiosInstance } from "axios";
import { logger } from "@/lib/logger";
import { IntegrationError } from "@/lib/integration-error";
import type {
  AiChatResult,
  AiConfig,
  AiMessage,
  AiProviderClient,
  AiToolCall,
  AiToolDefinition,
} from "./types";

// Local models can be slow to first token; give a generous per-request timeout.
// The chat route additionally caps total wall-clock via the progress stream.
const REQUEST_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;
// Bounded output per turn: analytical answers and tool-call args are short.
const MAX_TOKENS = 1500;

function makeHttp(config: AiConfig, headers: Record<string, string>): AxiosInstance {
  const http = axios.create({
    baseURL: config.baseUrl,
    timeout: REQUEST_TIMEOUT_MS,
    headers: { "Content-Type": "application/json", ...headers },
  });
  http.interceptors.response.use(
    (r) => r,
    (error) => {
      if (axios.isAxiosError(error)) {
        logger.debug("AI", `ERROR ${error.response?.status ?? "NETWORK"} ${error.config?.url}`, {
          message: error.message,
        });
        // IntegrationError collapses the AxiosError to a single safe line and
        // keeps the original as `cause`. sanitizeErrorDetail() scrubs it further
        // before anything reaches the client.
        return Promise.reject(new IntegrationError("AI", error));
      }
      return Promise.reject(error);
    },
  );
  return http;
}

function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

// ─── OpenAI-compatible (OpenAI, Ollama, LM Studio, OpenRouter, Groq, vLLM…) ──

class OpenAiCompatibleClient implements AiProviderClient {
  private http: AxiosInstance;
  constructor(private config: AiConfig) {
    // Local endpoints usually need no key; only send Authorization when set.
    this.http = makeHttp(
      config,
      config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    );
  }

  private toOpenAiMessages(messages: AiMessage[]) {
    return messages.map((m) => {
      switch (m.role) {
        case "system":
        case "user":
          return { role: m.role, content: m.content };
        case "assistant":
          return {
            role: "assistant",
            content: m.content || null,
            ...(m.toolCalls && m.toolCalls.length > 0
              ? {
                  tool_calls: m.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function",
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                  })),
                }
              : {}),
          };
        case "tool":
          return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      }
    });
  }

  async chat(
    messages: AiMessage[],
    tools: AiToolDefinition[],
    signal?: AbortSignal,
  ): Promise<AiChatResult> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: this.toOpenAiMessages(messages),
      max_tokens: MAX_TOKENS,
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }

    const { data } = await this.http.post("/chat/completions", body, { signal });
    const message = data?.choices?.[0]?.message ?? {};
    const toolCalls: AiToolCall[] = Array.isArray(message.tool_calls)
      ? message.tool_calls
          .filter((tc: unknown) => tc && typeof tc === "object")
          .map((tc: { id?: string; function?: { name?: string; arguments?: unknown } }, i: number) => ({
            id: tc.id ?? `call_${i}`,
            name: tc.function?.name ?? "",
            arguments: safeParseArgs(tc.function?.arguments),
          }))
          .filter((tc: AiToolCall) => tc.name)
      : [];
    return { content: typeof message.content === "string" ? message.content : "", toolCalls };
  }

  async testConnection(signal?: AbortSignal): Promise<{ ok: boolean; error?: string; model?: string }> {
    try {
      await this.http.post(
        "/chat/completions",
        {
          model: this.config.model,
          messages: [{ role: "user", content: "Reply with the single word: OK" }],
          max_tokens: 5,
        },
        { signal, timeout: TEST_TIMEOUT_MS },
      );
      return { ok: true, model: this.config.model };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Connection failed" };
    }
  }
}

// ─── Anthropic (native Claude Messages API) ─────────────────────────────

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

class AnthropicClient implements AiProviderClient {
  private http: AxiosInstance;
  constructor(private config: AiConfig) {
    this.http = makeHttp(config, {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    });
  }

  // Anthropic takes a top-level `system` string and strict user/assistant turns;
  // tool results ride inside a `user` message as `tool_result` blocks, and
  // consecutive tool results must be merged into one user turn.
  private toAnthropic(messages: AiMessage[]): {
    system: string;
    messages: { role: string; content: unknown[] }[];
  } {
    const systemParts: string[] = [];
    const out: { role: string; content: unknown[] }[] = [];
    let lastWasToolResult = false;

    for (const m of messages) {
      if (m.role === "system") {
        systemParts.push(m.content);
        continue;
      }
      if (m.role === "user") {
        out.push({ role: "user", content: [{ type: "text", text: m.content }] });
        lastWasToolResult = false;
      } else if (m.role === "assistant") {
        const content: unknown[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls ?? []) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
        }
        out.push({ role: "assistant", content });
        lastWasToolResult = false;
      } else {
        // tool result
        const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
        const last = out[out.length - 1];
        if (lastWasToolResult && last) {
          (last.content as unknown[]).push(block);
        } else {
          out.push({ role: "user", content: [block] });
          lastWasToolResult = true;
        }
      }
    }

    return { system: systemParts.join("\n\n"), messages: out };
  }

  async chat(
    messages: AiMessage[],
    tools: AiToolDefinition[],
    signal?: AbortSignal,
  ): Promise<AiChatResult> {
    const { system, messages: anthropicMessages } = this.toAnthropic(messages);
    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: MAX_TOKENS,
      messages: anthropicMessages,
    };
    if (system) body.system = system;
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const { data } = await this.http.post("/v1/messages", body, { signal });
    const blocks: AnthropicBlock[] = Array.isArray(data?.content) ? data.content : [];
    const content = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    const toolCalls: AiToolCall[] = blocks
      .filter((b) => b.type === "tool_use")
      .map((b, i) => ({
        id: b.id ?? `call_${i}`,
        name: b.name ?? "",
        arguments: b.input && typeof b.input === "object" ? b.input : {},
      }))
      .filter((tc) => tc.name);
    return { content, toolCalls };
  }

  async testConnection(signal?: AbortSignal): Promise<{ ok: boolean; error?: string; model?: string }> {
    try {
      await this.http.post(
        "/v1/messages",
        {
          model: this.config.model,
          max_tokens: 5,
          messages: [{ role: "user", content: "Reply with the single word: OK" }],
        },
        { signal, timeout: TEST_TIMEOUT_MS },
      );
      return { ok: true, model: this.config.model };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Connection failed" };
    }
  }
}

/** Build the provider client for a resolved config. */
export function createProvider(config: AiConfig): AiProviderClient {
  return config.provider === "anthropic"
    ? new AnthropicClient(config)
    : new OpenAiCompatibleClient(config);
}
