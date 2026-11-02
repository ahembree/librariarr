import { describe, it, expect } from "vitest";
import { chatHistoryForRequest, MAX_CHAT_CONTENT, MAX_CHAT_MESSAGES } from "@/components/ai/chat-history";
import { aiChatSchema } from "@/lib/validation";

type Turn = { role: "user" | "assistant"; content: string };

/** `n` alternating turns, user first. */
function conversation(n: number): Turn[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `turn ${i}`,
  }));
}

describe("chatHistoryForRequest", () => {
  // The page sent the whole conversation, so the 21st question (41 turns) was
  // refused, the refusal was appended as another turn, and the chat was dead
  // until a reload.
  it("keeps a long conversation within the chat route's limit", () => {
    const sent = chatHistoryForRequest(conversation(41));
    // The last 40 turns, less the assistant turn that would open them.
    expect(sent).toHaveLength(MAX_CHAT_MESSAGES - 1);
    expect(sent[0]).toEqual({ role: "user", content: "turn 2" });
    expect(aiChatSchema.safeParse({ messages: sent }).success).toBe(true);
    // The newest question is always the last turn sent.
    expect(sent.at(-1)).toEqual({ role: "user", content: "turn 40" });
  });

  it("starts the window on a user turn", () => {
    // The last 40 of 43 turns open with an assistant turn ("turn 3"), which the
    // native Anthropic API refuses; the window starts at the next question.
    const sent = chatHistoryForRequest(conversation(43));
    expect(sent[0]).toEqual({ role: "user", content: "turn 4" });
    expect(sent).toHaveLength(39);
    expect(sent.at(-1)).toEqual({ role: "user", content: "turn 42" });
  });

  it("sends nothing when there is no user turn to start from", () => {
    expect(chatHistoryForRequest([{ role: "assistant", content: "Hello! Ask me about your library." }])).toEqual([]);
  });

  it("cuts an over-long turn to the content limit instead of failing the request", () => {
    const sent = chatHistoryForRequest([
      { role: "user", content: "q" },
      { role: "assistant", content: "x".repeat(MAX_CHAT_CONTENT + 500) },
      { role: "user", content: "follow-up" },
    ]);
    expect(sent[1].content).toHaveLength(MAX_CHAT_CONTENT);
    expect(aiChatSchema.safeParse({ messages: sent }).success).toBe(true);
  });

  it("drops empty turns, which the route refuses", () => {
    expect(
      chatHistoryForRequest([
        { role: "user", content: "q" },
        { role: "assistant", content: "  " },
        { role: "user", content: "hi" },
      ]),
    ).toEqual([
      { role: "user", content: "q" },
      { role: "user", content: "hi" },
    ]);
  });

  it("passes a short conversation through unchanged", () => {
    expect(chatHistoryForRequest(conversation(3))).toEqual(conversation(3));
  });

  // The limits are repeated in the client module so the page does not import
  // zod; this keeps the copy honest.
  it("uses the same limits as aiChatSchema", () => {
    expect(aiChatSchema.safeParse({ messages: conversation(MAX_CHAT_MESSAGES + 1) }).success).toBe(false);
    expect(aiChatSchema.safeParse({ messages: conversation(MAX_CHAT_MESSAGES) }).success).toBe(true);
    const long = [{ role: "user", content: "x".repeat(MAX_CHAT_CONTENT + 1) }];
    expect(aiChatSchema.safeParse({ messages: long }).success).toBe(false);
    expect(aiChatSchema.safeParse({ messages: [{ role: "user", content: "x".repeat(MAX_CHAT_CONTENT) }] }).success).toBe(true);
  });
});
