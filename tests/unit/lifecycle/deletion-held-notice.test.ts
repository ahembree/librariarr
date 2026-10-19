import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ findFirst: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { appSettings: { findFirst: m.findFirst } } }));
vi.mock("@/lib/discord/client", () => ({ sendDiscordNotification: m.send }));

import { notifyDeleteCeilingHeld, notifyDeletionHeld, _resetHoldNoticeForTesting } from "@/lib/lifecycle/deletion-held-notice";

const SETTINGS = { discordWebhookUrl: "https://discord/hook", discordWebhookUsername: "Media Bot", discordWebhookAvatarUrl: "https://img/a.png" };

beforeEach(() => {
  vi.clearAllMocks();
  _resetHoldNoticeForTesting();
  m.findFirst.mockResolvedValue(SETTINGS);
  m.send.mockResolvedValue(true);
});

describe("deletion held notices", () => {
  it("post with the webhook's own name and avatar", async () => {
    // It used to be the one notification that ignored them.
    await notifyDeletionHeld("u1", "held");
    expect(m.send).toHaveBeenCalledWith("https://discord/hook", expect.objectContaining({
      username: "Media Bot",
      avatar_url: "https://img/a.png",
    }));
  });

  it("send nothing without a webhook", async () => {
    m.findFirst.mockResolvedValue({ discordWebhookUrl: null });
    await notifyDeletionHeld("u1", "held");
    expect(m.send).not.toHaveBeenCalled();
  });

  it("tell a scheduled run to execute in smaller groups", async () => {
    await notifyDeleteCeilingHeld("u1", { count: 150, limit: 100 }, "scheduled");
    const description = m.send.mock.calls[0][1].embeds[0].description as string;
    expect(description).toContain("**150**");
    expect(description).toContain("at most **100** at a time");
  });

  it("announce a hand-started run at most once per 15 minutes", async () => {
    // Execute and the API's execute endpoint can be called in a loop.
    await notifyDeleteCeilingHeld("u1", { count: 30, limit: 25 }, "manual", "a Query page action");
    await notifyDeleteCeilingHeld("u1", { count: 30, limit: 25 }, "manual", "a Query page action");
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send.mock.calls[0][1].embeds[0].description).toContain("started by hand (a Query page action)");
  });

  it("throttle a scheduled-kind run queued through an API key", async () => {
    await notifyDeleteCeilingHeld("u1", { count: 3, limit: 2 }, "scheduled", undefined, { throttle: true });
    await notifyDeleteCeilingHeld("u1", { count: 3, limit: 2 }, "scheduled", undefined, { throttle: true });
    expect(m.send).toHaveBeenCalledTimes(1);
  });

  it("never throttle a scheduled run's notice", async () => {
    await notifyDeleteCeilingHeld("u1", { count: 3, limit: 2 }, "scheduled");
    await notifyDeleteCeilingHeld("u1", { count: 3, limit: 2 }, "scheduled");
    expect(m.send).toHaveBeenCalledTimes(2);
  });
});
