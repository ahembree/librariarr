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
    await page.route(isPath("/api/settings/ai"), (route) =>
      route.fulfill({ json: { enabled: true, provider: "openai-compatible", baseUrl: "http://llm.lan", model: "test-model" } }),
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

    const last = requests.at(-1)!.postDataJSON() as { messages: { role: string; content: string }[] };
    expect(last.messages.length).toBeLessThanOrEqual(40);
    expect(last.messages[0].role).toBe("user");
    expect(last.messages.at(-1)).toEqual({ role: "user", content: "question 21" });
  });

  test("a validation refusal names what was wrong", async ({ page }) => {
    await page.route(isPath("/api/ai/chat"), (route) =>
      route.fulfill({ status: 400, json: { error: "Validation failed", details: ["messages.0.content: Too big"] } }),
    );

    await page.goto("/tools/ai");
    const box = page.getByRole("textbox");
    await box.fill("how many movies?");
    await box.press("Enter");
    await expect(page.getByText(/Validation failed — messages\.0\.content: Too big/)).toBeVisible();
  });
});
