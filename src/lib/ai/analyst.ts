import { createProvider } from "./provider";
import { getAiToolMap, getAiTools } from "./tools";
import { buildSystemPrompt } from "./system-prompt";
import type {
  AiChatResponse,
  AiConfig,
  AiEvidence,
  AiMessage,
  AiStreamEvent,
  AiToolDefinition,
} from "./types";

// Hard cap on the tool-calling loop so a misbehaving model can't spin forever.
const MAX_ITERATIONS = 6;

const TOOL_LABELS: Record<string, string> = {
  get_library_overview: "Summarizing your library",
  get_breakdown: "Computing a distribution",
  get_cross_tab: "Cross-tabulating",
  get_timeline: "Building a timeline",
  search_media: "Searching the library",
  get_watch_trends: "Checking recent activity",
  get_watch_leaderboard: "Ranking recent activity",
};

export interface AnalystInput {
  userId: string;
  config: AiConfig;
  messages: { role: "user" | "assistant"; content: string }[];
}

/**
 * Run the read-only analysis agent: hand the model the question + the tool set,
 * execute whatever read-only tools it calls, feed the results back, and repeat
 * until it produces a final answer (bounded by MAX_ITERATIONS). Intermediate
 * progress is reported via `emit`; the final answer + structured evidence for
 * the UI are returned.
 */
export async function runAnalyst(
  input: AnalystInput,
  emit: (event: AiStreamEvent) => void,
  signal?: AbortSignal,
): Promise<AiChatResponse> {
  const provider = createProvider(input.config);
  const toolMap = getAiToolMap();
  const toolDefs: AiToolDefinition[] = getAiTools().map((t) => t.definition);

  const messages: AiMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    ...input.messages.map((m) => ({ role: m.role, content: m.content }) as AiMessage),
  ];

  const evidence: AiEvidence[] = [];
  let answer = "";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal?.aborted) break;
    emit({ type: "status", label: i === 0 ? "Analyzing your question" : "Reviewing the results" });

    const result = await provider.chat(messages, toolDefs, signal);

    if (result.toolCalls.length === 0) {
      answer = result.content.trim();
      break;
    }

    messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });

    for (const call of result.toolCalls) {
      if (signal?.aborted) break;
      emit({ type: "tool", tool: call.name, label: TOOL_LABELS[call.name] ?? `Running ${call.name}` });
      const tool = toolMap.get(call.name);
      let data: unknown;
      if (!tool) {
        data = { error: `Unknown tool "${call.name}".` };
      } else {
        try {
          const res = await tool.execute(input.userId, call.arguments);
          data = res.data;
          if (res.evidence) evidence.push(res.evidence);
        } catch (err) {
          data = { error: err instanceof Error ? err.message : "Tool failed." };
        }
      }
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(data) });
    }
  }

  // The model kept calling tools without concluding: ask once more for a
  // plain-text answer with tools disabled so we always return something.
  if (!answer && !signal?.aborted) {
    emit({ type: "status", label: "Writing the answer" });
    try {
      const final = await provider.chat(
        [
          ...messages,
          {
            role: "user",
            content:
              "Now answer my question directly in concise Markdown, using only the data already gathered. Do not call any tools.",
          },
        ],
        [],
        signal,
      );
      answer = final.content.trim();
    } catch {
      // fall through to the fallback message
    }
  }

  if (!answer) {
    answer =
      evidence.length > 0
        ? "I gathered the data but couldn't compose a written summary — see the results below."
        : "I couldn't produce an answer. Check the AI connection under Settings → AI, or try rephrasing your question.";
  }

  return { answer, evidence };
}
