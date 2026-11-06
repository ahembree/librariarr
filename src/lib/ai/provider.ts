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

// Local models (and thinking models) can take minutes to answer one turn on
// modest hardware; a shorter cap aborted them mid-generation. The chat route
// caps the run's total wall-clock via the progress stream's lifetime.
export const REQUEST_TIMEOUT_MS = 10 * 60_000;
// The test may cold-load a local model into memory before it answers.
export const TEST_TIMEOUT_MS = 3 * 60_000;
// Output cap per turn. Thinking models (Qwen 3.x, DeepSeek-R1, gpt-oss, …)
// spend output tokens on reasoning before the answer or tool call; a small cap
// ended the turn mid-thought with an empty answer.
export const MAX_TOKENS = 8192;
// Older models cap output lower (Claude 3 Haiku/Opus, GPT-4-Turbo,
// GPT-3.5: 4096) and refuse a request asking for more; the client retries once
// at this cap and keeps it for the rest of the run.
export const FALLBACK_MAX_TOKENS = 4096;

/** A 400 refusing the requested output size (each provider words it its own way). */
function isMaxTokensRefusal(error: unknown): boolean {
  return (
    error instanceof IntegrationError &&
    error.status === 400 &&
    /max_tokens|max_completion_tokens|max_output_tokens|output tokens|maximum.*tokens/i.test(error.detail ?? "")
  );
}

// A model server answers 5xx when it can't parse the model's own output: Ollama
// returns `500: invalid character '\x00' looking for beginning of value` (a Go
// JSON error) when a model such as Qwen 3.5 emits a malformed tool call. The
// output is sampled, so the same request usually succeeds on a retry.
export const MODEL_ERROR_RETRIES = 2;

function isServerError(error: unknown): boolean {
  return error instanceof IntegrationError && error.status !== null && error.status >= 500;
}

/** The server's JSON decoder choked on what the model generated (a tool call, as a rule). */
function isModelOutputParseFailure(error: unknown): boolean {
  return (
    isServerError(error) &&
    /looking for beginning of value|invalid character|error parsing tool call|unexpected end of JSON/i.test(
      (error as IntegrationError).detail ?? "",
    )
  );
}

export const MODEL_OUTPUT_PARSE_HINT =
  "The model server couldn't parse the model's own output (usually a malformed tool call). This is a model or model-server issue, not the model name: update the server (e.g. Ollama), or try a different model or quantization.";

/**
 * POST a completion request with `max_tokens` at the client's current cap,
 * retrying once at FALLBACK_MAX_TOKENS when the model refuses the size, and up
 * to MODEL_ERROR_RETRIES times when the server answers 5xx. The lowered cap is
 * returned so the client keeps using it. A final parse failure carries
 * MODEL_OUTPUT_PARSE_HINT in its message.
 */
async function postWithTokenCap(
  http: AxiosInstance,
  url: string,
  body: Record<string, unknown>,
  cap: number,
  options: { signal?: AbortSignal; timeout?: number },
): Promise<{ data: unknown; cap: number }> {
  let serverErrors = 0;
  for (;;) {
    try {
      const { data } = await http.post(url, { ...body, max_tokens: cap }, options);
      return { data, cap };
    } catch (error) {
      if (cap > FALLBACK_MAX_TOKENS && isMaxTokensRefusal(error)) {
        cap = FALLBACK_MAX_TOKENS;
        continue;
      }
      if (isServerError(error) && serverErrors < MODEL_ERROR_RETRIES && !options.signal?.aborted) {
        serverErrors++;
        // Status and code only: the message carries the provider's own error
        // text, which may echo request content.
        logger.debug("AI", `Model server error, retrying (${serverErrors}/${MODEL_ERROR_RETRIES})`, {
          status: (error as IntegrationError).status,
          code: (error as IntegrationError).code,
        });
        continue;
      }
      if (isModelOutputParseFailure(error)) (error as Error).message += ` — ${MODEL_OUTPUT_PARSE_HINT}`;
      throw error;
    }
  }
}

// The connection test sends one harmless tool so a model or server that
// can't do tool calling fails the test, as it would fail every question.
const TEST_TOOL: AiToolDefinition = {
  name: "ping",
  description: "Not needed for this request. Do not call it.",
  parameters: { type: "object", properties: {} },
};
const TEST_PROMPT = "Reply with the single word: OK";
const EMPTY_TEST_ANSWER =
  "The model returned an empty answer. A thinking model may have spent its whole output budget on reasoning, or the model can't answer through this endpoint.";

/** Shared connection test: a real turn with a tool attached must produce an answer or a tool call. */
async function runConnectionTest(
  complete: (timeout: number) => Promise<AiChatResult>,
  model: string,
): Promise<{ ok: boolean; error?: string; model?: string }> {
  try {
    const result = await complete(TEST_TIMEOUT_MS);
    if (!result.content.trim() && result.toolCalls.length === 0) return { ok: false, error: EMPTY_TEST_ANSWER };
    return { ok: true, model };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Connection failed" };
  }
}

/**
 * Drop the reasoning a thinking model inlines in its content
 * (`<think>…</think>`, as some OpenAI-compatible servers return it) so only the
 * answer reaches the user. A bare closing tag (opening tag in the prompt)
 * drops everything before it; an unterminated block (output cut off
 * mid-thought) leaves no answer.
 */
export function stripThinking(content: string): string {
  let out = content.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Qwen3 / DeepSeek-R1 chat templates put the opening <think> in the prompt,
  // so the generated text is "reasoning…</think>answer": everything up to the
  // last closing tag is reasoning.
  const close = out.toLowerCase().lastIndexOf("</think>");
  if (close !== -1) out = out.slice(close + "</think>".length);
  return out.replace(/<think>[\s\S]*$/i, "").trim();
}

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
  private maxTokens = MAX_TOKENS;
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

  chat(messages: AiMessage[], tools: AiToolDefinition[], signal?: AbortSignal): Promise<AiChatResult> {
    return this.complete(messages, tools, signal);
  }

  private async complete(
    messages: AiMessage[],
    tools: AiToolDefinition[],
    signal?: AbortSignal,
    timeout?: number,
  ): Promise<AiChatResult> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: this.toOpenAiMessages(messages),
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }

    const sent = await postWithTokenCap(this.http, "/chat/completions", body, this.maxTokens, { signal, timeout });
    this.maxTokens = sent.cap;
    const data = sent.data as { choices?: { message?: Record<string, unknown> }[] } | undefined;
    const message = (data?.choices?.[0]?.message ?? {}) as { content?: unknown; tool_calls?: unknown };
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
    return { content: typeof message.content === "string" ? stripThinking(message.content) : "", toolCalls };
  }

  testConnection(signal?: AbortSignal): Promise<{ ok: boolean; error?: string; model?: string }> {
    return runConnectionTest(
      (timeout) => this.complete([{ role: "user", content: TEST_PROMPT }], [TEST_TOOL], signal, timeout),
      this.config.model,
    );
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
  private maxTokens = MAX_TOKENS;
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

  chat(messages: AiMessage[], tools: AiToolDefinition[], signal?: AbortSignal): Promise<AiChatResult> {
    return this.complete(messages, tools, signal);
  }

  private async complete(
    messages: AiMessage[],
    tools: AiToolDefinition[],
    signal?: AbortSignal,
    timeout?: number,
  ): Promise<AiChatResult> {
    const { system, messages: anthropicMessages } = this.toAnthropic(messages);
    const body: Record<string, unknown> = {
      model: this.config.model,
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

    const sent = await postWithTokenCap(this.http, "/v1/messages", body, this.maxTokens, { signal, timeout });
    this.maxTokens = sent.cap;
    const data = sent.data as { content?: unknown } | undefined;
    const blocks: AnthropicBlock[] = Array.isArray(data?.content) ? (data.content as AnthropicBlock[]) : [];
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

  testConnection(signal?: AbortSignal): Promise<{ ok: boolean; error?: string; model?: string }> {
    return runConnectionTest(
      (timeout) => this.complete([{ role: "user", content: TEST_PROMPT }], [TEST_TOOL], signal, timeout),
      this.config.model,
    );
  }

}

/** Build the provider client for a resolved config. */
export function createProvider(config: AiConfig): AiProviderClient {
  return config.provider === "anthropic"
    ? new AnthropicClient(config)
    : new OpenAiCompatibleClient(config);
}
