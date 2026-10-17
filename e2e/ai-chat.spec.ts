import { test, expect, type Request } from "@playwright/test";

/**
 * AI Analysis with the assistant stubbed (no model is ever called).
 *
 * - The page sends only the newest turns the chat route accepts (40). It used
 *   to send the whole conversation, so the 21st question was refused, the
 *   refusal became another turn, and every question after it failed the same
 *   way until a reload.
 * - A validation refusal shows what was wrong, not just "Validation failed".
 */

const isPath = (path: string) => (url: URL) => url.pathname === path;

test.describe("tools — AI Analysis", () => {
  test.beforeEach(async ({ page }) => {
    // The GET route's shape: the key itself is never sent, only whether one is stored.
    await page.route(isPath("/api/settings/ai"), (route) =>
      route.fulfill({
        json: {
          enabled: true,
          provider: "openai-compatible",
          baseUrl: "http://llm.lan:11434/v1",
          model: "llama3.1:8b",
          apiKey: "",
          hasApiKey: false,
        },
      }),
    );
  });

  test("a long conversation keeps going: only the newest turns are sent", async ({ page }) => {
    const requests: Request[] = [];
    await page.route(isPath("/api/ai/chat"), (route) => {
      requests.push(route.request());
      const { messages } = route.request().postDataJSON() as { messages: unknown[] };
      // The route's own limit (aiChatSchema).
      if (messages.length > 40) {
        return route.fulfill({ status: 400, json: { error: "Validation failed", details: ["messages: Conversation is too long"] } });
      }
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
        body: `${JSON.stringify({ type: "result", result: { answer: `answer ${requests.length}`, evidence: [] } })}\n`,
      });
    });

    await page.goto("/tools/ai");
    const box = page.getByRole("textbox");
    for (let i = 1; i <= 21; i++) {
      await box.fill(`question ${i}`);
      await box.press("Enter");
      await expect(page.getByText(`answer ${i}`, { exact: true })).toBeVisible();
    }

    expect(requests).toHaveLength(21);
    // 41 turns by then (20 questions, 20 answers, the 21st question): the
    // newest 40 open on "answer 1", which is dropped so the history starts on
    // a user turn — 39 turns, "question 2" through "question 21".
    const last = requests.at(-1)!.postDataJSON() as { messages: { role: string; content: string }[] };
    expect(last.messages).toHaveLength(39);
    expect(last.messages[0]).toEqual({ role: "user", content: "question 2" });
    expect(last.messages[1]).toEqual({ role: "assistant", content: "answer 2" });
    expect(last.messages.at(-1)).toEqual({ role: "user", content: "question 21" });
  });

  test("a validation refusal names what was wrong", async ({ page }) => {
    await page.route(isPath("/api/ai/chat"), (route) =>
      // validateRequest's detail format: `<path>: <zod message>`.
      route.fulfill({
        status: 400,
        json: { error: "Validation failed", details: ["messages.0.content: Too big: expected string to have <=8000 characters"] },
      }),
    );

    await page.goto("/tools/ai");
    const box = page.getByRole("textbox");
    await box.fill("how many movies?");
    await box.press("Enter");
    await expect(
      page.getByText("Validation failed — messages.0.content: Too big: expected string to have <=8000 characters"),
    ).toBeVisible();
  });
});
