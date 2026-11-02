/**
 * The slice of the AI Analysis conversation sent with each question.
 *
 * Client-safe and pure (unit-tested). The page used to send the whole
 * conversation, and `aiChatSchema` in src/lib/validation.ts refuses more than
 * `MAX_CHAT_MESSAGES` turns or a turn over `MAX_CHAT_CONTENT` characters — so
 * the 21st question failed with a bare "Validation failed", that failure was
 * appended as another turn, and every question after it failed the same way
 * until the page was reloaded. The limits are repeated here rather than
 * imported so the page does not pull zod into its bundle; keep them in step.
 */

/** `aiChatSchema`'s `messages.max(…)`. */
export const MAX_CHAT_MESSAGES = 40;
/** `aiChatMessageSchema`'s `content.max(…)`. */
export const MAX_CHAT_CONTENT = 8000;

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * The most recent turns that fit the route's limits, starting on a user turn
 * (the native Anthropic API refuses a conversation that opens with the
 * assistant), each cut to the content limit and none empty.
 */
export function chatHistoryForRequest(history: readonly ChatTurn[]): ChatTurn[] {
  const recent = history.slice(-MAX_CHAT_MESSAGES);
  const firstUser = recent.findIndex((turn) => turn.role === "user");
  if (firstUser === -1) return [];
  return recent
    .slice(firstUser)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, MAX_CHAT_CONTENT) }))
    .filter((turn) => turn.content.trim().length > 0);
}
