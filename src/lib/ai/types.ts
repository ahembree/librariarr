/**
 * Shared types for the AI analysis assistant. The assistant is a read-only,
 * tool-calling agent over the media library: it translates a natural-language
 * question into calls to a fixed set of validated, read-only tools (query +
 * aggregation), then narrates the real returned data. It never mutates anything.
 */

export type AiProvider = "openai-compatible" | "anthropic";

/** A fully-resolved connection config (provider default applied to baseUrl). */
export interface AiConfig {
  provider: AiProvider;
  baseUrl: string;
  /** May be empty — local models (Ollama, LM Studio) often need no key. */
  apiKey: string;
  model: string;
}

// ─── Chat message model (provider-neutral) ──────────────────────────────

export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: AiToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** JSON-Schema tool definition handed to the provider. */
export interface AiToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One provider round-trip: assistant text plus any tool calls it requested. */
export interface AiChatResult {
  content: string;
  toolCalls: AiToolCall[];
}

/** Provider-neutral client the orchestrator drives. */
export interface AiProviderClient {
  chat(
    messages: AiMessage[],
    tools: AiToolDefinition[],
    signal?: AbortSignal,
  ): Promise<AiChatResult>;
  testConnection(signal?: AbortSignal): Promise<{ ok: boolean; error?: string; model?: string }>;
}

// ─── Tool layer ─────────────────────────────────────────────────────────

export type AiEvidenceKind =
  | "overview"
  | "breakdown"
  | "cross_tab"
  | "timeline"
  | "search"
  | "watch_trends"
  | "watch_leaderboard";

/** Structured result attached to the final answer so the UI can chart it. */
export interface AiEvidence {
  tool: string;
  kind: AiEvidenceKind;
  title: string;
  data: unknown;
}

export interface AiToolResult {
  /** JSON-serializable payload returned to the model as the tool result. */
  data: unknown;
  /** Optional structured evidence for the UI (charts/tables). */
  evidence?: AiEvidence;
}

export interface AiTool {
  definition: AiToolDefinition;
  execute(userId: string, args: Record<string, unknown>): Promise<AiToolResult>;
}

// ─── Streaming (NDJSON) contract with the browser ───────────────────────

/** Intermediate events emitted while the assistant works (live "thinking"). */
export type AiStreamEvent =
  | { type: "status"; label: string }
  | { type: "tool"; tool: string; label: string };

/** Terminal payload (delivered as the stream's `{ type: "result", result }`). */
export interface AiChatResponse {
  answer: string;
  evidence: AiEvidence[];
}
