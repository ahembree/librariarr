import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  send: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { appSettings: { findUnique: m.findUnique } } }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: m.warn, error: vi.fn() },
}));
vi.mock("@/lib/discord/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord/client")>()),
  sendDiscordNotification: m.send,
}));

import { notifyApiKeyChange } from "@/lib/api-keys/notify";

const KEY = {
  name: "Home Assistant",
  prefix: "lbr_Ab3xYz",
  scopes: ["media:read"],
  expiresAt: null,
};

function settings(overrides: Record<string, unknown> = {}) {
  return {
    discordWebhookUrl: "https://discord.com/api/webhooks/1/abc",
    discordWebhookUsername: null,
    discordWebhookAvatarUrl: "https://example.com/a.png",
    discordNotifyApiKeys: true,
    ...overrides,
  };
}

describe("notifyApiKeyChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.send.mockResolvedValue({ ok: true });
  });

  it("posts a created-key embed to the configured webhook with the configured identity", async () => {
    m.findUnique.mockResolvedValue(settings());
    await notifyApiKeyChange("user-1", "created", KEY);
    expect(m.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-1" } }));
    expect(m.send).toHaveBeenCalledTimes(1);
    const [url, payload] = m.send.mock.calls[0];
    expect(url).toBe("https://discord.com/api/webhooks/1/abc");
    expect(payload).toMatchObject({
      username: "Librariarr",
      avatar_url: "https://example.com/a.png",
      embeds: [expect.objectContaining({ title: "API Key Created" })],
    });
  });

  it("uses the custom webhook username when one is set", async () => {
    m.findUnique.mockResolvedValue(settings({ discordWebhookUsername: "Bot" }));
    await notifyApiKeyChange("user-1", "deleted", KEY);
    expect(m.send.mock.calls[0][1]).toMatchObject({
      username: "Bot",
      embeds: [expect.objectContaining({ title: "API Key Deleted" })],
    });
  });

  it.each([
    ["the toggle is off", settings({ discordNotifyApiKeys: false })],
    ["no webhook is set", settings({ discordWebhookUrl: null })],
    ["there are no settings at all", null],
  ])("sends nothing when %s", async (_label, row) => {
    m.findUnique.mockResolvedValue(row);
    await notifyApiKeyChange("user-1", "created", KEY);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("never throws — a failed lookup or send is logged and swallowed", async () => {
    m.findUnique.mockRejectedValue(new Error("db down"));
    await expect(notifyApiKeyChange("user-1", "created", KEY)).resolves.toBeUndefined();
    expect(m.warn).toHaveBeenCalledWith("Auth", expect.stringMatching(/Discord notification/), {
      error: "Error: db down",
    });

    m.findUnique.mockResolvedValue(settings());
    m.send.mockRejectedValue(new Error("discord down"));
    await expect(notifyApiKeyChange("user-1", "deleted", KEY)).resolves.toBeUndefined();
  });
});
