import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildApiKeyEmbed,
  sendDiscordNotification,
  buildSuccessSummaryEmbed,
  buildFailureSummaryEmbed,
  buildMatchChangeEmbed,
  buildMaintenanceEmbed,
} from "@/lib/discord/client";

describe("sendDiscordNotification", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends POST to webhook URL and returns ok on 2xx", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendDiscordNotification("https://discord.com/api/webhooks/123/abc", {
      content: "Hello!",
    });

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123/abc",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Hello!" }),
      }),
    );
  });

  it("returns error when webhook returns non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("Rate limited"),
      }),
    );

    const result = await sendDiscordNotification("https://discord.com/api/webhooks/123/abc", {
      content: "Hello!",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("429");
    expect(result.error).toContain("Rate limited");
  });

  it("returns error when response.text() rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error("body error")),
      }),
    );

    const result = await sendDiscordNotification("https://discord.com/api/webhooks/123/abc", {
      content: "Hello!",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
    expect(result.error).toContain("Unknown error");
  });

  it("returns error when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error")),
    );

    const result = await sendDiscordNotification("https://discord.com/api/webhooks/123/abc", {
      content: "Hello!",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Network error");
  });

  it("handles non-Error throw from fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("string error"));

    const result = await sendDiscordNotification("https://discord.com/api/webhooks/123/abc", {
      content: "Hello!",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Unknown error");
  });
});

describe("buildSuccessSummaryEmbed", () => {
  it("builds embed with correct structure for single item", () => {
    const embed = buildSuccessSummaryEmbed("My Rule", "DELETE_RADARR", ["Movie A"]);

    expect(embed.title).toBe("1 Action Completed");
    expect(embed.description).toContain("1 lifecycle action completed");
    expect(embed.color).toBe(0x22c55e);
    expect(embed.fields).toBeDefined();
    expect(embed.fields!.find((f) => f.name === "Rule")?.value).toBe("My Rule");
    expect(embed.fields!.find((f) => f.name === "Action")?.value).toBe("Delete from Radarr");
    expect(embed.fields!.find((f) => f.name === "Completed")?.value).toBe("1");
    expect(embed.footer?.text).toBe("Librariarr Lifecycle");
    expect(embed.timestamp).toBeDefined();
  });

  it("pluralizes title for multiple items", () => {
    const embed = buildSuccessSummaryEmbed("My Rule", "UNMONITOR_SONARR", ["A", "B", "C"]);

    expect(embed.title).toBe("3 Actions Completed");
    expect(embed.description).toContain("3 lifecycle actions completed");
    expect(embed.fields!.find((f) => f.name === "Action")?.value).toBe("Unmonitor in Sonarr");
  });

  it("falls back to raw action type for unknown actions", () => {
    const embed = buildSuccessSummaryEmbed("Rule", "CUSTOM_ACTION", ["A"]);
    expect(embed.fields!.find((f) => f.name === "Action")?.value).toBe("CUSTOM_ACTION");
  });

  it("maps DO_NOTHING to Monitor Only", () => {
    const embed = buildSuccessSummaryEmbed("Rule", "DO_NOTHING", ["A"]);
    expect(embed.fields!.find((f) => f.name === "Action")?.value).toBe("Monitor Only");
  });
});

describe("buildFailureSummaryEmbed", () => {
  it("builds embed with red color and failure info", () => {
    const failures = [
      { title: "Movie A", error: "Not found in Radarr" },
      { title: "Movie B", error: "Title mismatch" },
    ];
    const embed = buildFailureSummaryEmbed("My Rule", "DELETE_RADARR", failures);

    expect(embed.title).toBe("2 Actions Failed");
    expect(embed.color).toBe(0xef4444);
    expect(embed.fields!.find((f) => f.name === "Failed")?.value).toBe("2");
    expect(embed.fields!.find((f) => f.name === "Items")?.value).toContain("Movie A");
    expect(embed.fields!.find((f) => f.name === "Items")?.value).toContain("Not found in Radarr");
  });

  it("singular title for single failure", () => {
    const embed = buildFailureSummaryEmbed("Rule", "DELETE_SONARR", [
      { title: "Show A", error: "err" },
    ]);
    expect(embed.title).toBe("1 Action Failed");
    expect(embed.description).toContain("1 lifecycle action failed");
  });
});

describe("buildMatchChangeEmbed", () => {
  it("builds embed with both added and removed counts", () => {
    const embed = buildMatchChangeEmbed("My Rule", 3, 2, "MOVIE", ["A", "B", "C"], ["D", "E"]);

    expect(embed.title).toBe("Rule Match Update: My Rule");
    expect(embed.description).toContain("3 new matches found");
    expect(embed.description).toContain("2 matches removed");
    expect(embed.color).toBe(0x3b82f6);
    expect(embed.fields!.find((f) => f.name === "New Matches")?.value).toBe("3");
    expect(embed.fields!.find((f) => f.name === "Removed Matches")?.value).toBe("2");
    expect(embed.fields!.find((f) => f.name === "Type")?.value).toBe("MOVIE");
    expect(embed.fields!.find((f) => f.name === "Added Items")).toBeDefined();
    expect(embed.fields!.find((f) => f.name === "Removed Items")).toBeDefined();
  });

  it("builds description for adds only", () => {
    const embed = buildMatchChangeEmbed("Rule", 1, 0, "SERIES");
    expect(embed.description).toBe("1 new match found.");
    expect(embed.fields!.find((f) => f.name === "New Matches")).toBeDefined();
    expect(embed.fields!.find((f) => f.name === "Removed Matches")).toBeUndefined();
  });

  it("builds description for removes only", () => {
    const embed = buildMatchChangeEmbed("Rule", 0, 5, "MUSIC");
    expect(embed.description).toBe("5 matches removed.");
    expect(embed.fields!.find((f) => f.name === "New Matches")).toBeUndefined();
    expect(embed.fields!.find((f) => f.name === "Removed Matches")).toBeDefined();
  });

  it("uses singular form for 1 added match", () => {
    const embed = buildMatchChangeEmbed("Rule", 1, 0, "MOVIE");
    expect(embed.description).toBe("1 new match found.");
  });

  it("uses singular form for 1 removed match", () => {
    const embed = buildMatchChangeEmbed("Rule", 0, 1, "MOVIE");
    expect(embed.description).toBe("1 match removed.");
  });

  it("omits title lists when not provided", () => {
    const embed = buildMatchChangeEmbed("Rule", 2, 1, "MOVIE");
    expect(embed.fields!.find((f) => f.name === "Added Items")).toBeUndefined();
    expect(embed.fields!.find((f) => f.name === "Removed Items")).toBeUndefined();
  });
});

describe("buildMaintenanceEmbed", () => {
  it("builds enabled embed with amber color", () => {
    const embed = buildMaintenanceEmbed(true, "System upgrade in progress");

    expect(embed.title).toBe("Maintenance Mode Enabled");
    expect(embed.description).toContain("activated");
    expect(embed.description).toContain("System upgrade in progress");
    expect(embed.color).toBe(0xf59e0b);
    expect(embed.footer?.text).toBe("Librariarr Maintenance");
  });

  it("builds enabled embed without message", () => {
    const embed = buildMaintenanceEmbed(true);
    expect(embed.description).toContain("activated");
    expect(embed.description).not.toContain("Message:");
  });

  it("builds disabled embed with green color", () => {
    const embed = buildMaintenanceEmbed(false);

    expect(embed.title).toBe("Maintenance Mode Disabled");
    expect(embed.description).toContain("deactivated");
    expect(embed.color).toBe(0x22c55e);
  });
});

describe("buildApiKeyEmbed", () => {
  const key = {
    name: "Home Assistant",
    prefix: "lbr_Ab3xYz",
    scopes: ["media:read", "servers:read"],
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  };

  it("announces a created key with its scopes and expiry, and says what to do if it was not you", () => {
    const embed = buildApiKeyEmbed("created", key);
    expect(embed.title).toBe("API Key Created");
    expect(embed.description).toMatch(/if you did not do this/i);
    expect(embed.fields).toEqual([
      { name: "Name", value: "Home Assistant", inline: true },
      { name: "Key", value: "lbr_Ab3xYz…", inline: true },
      { name: "Scopes", value: "media:read, servers:read", inline: false },
      { name: "Expires", value: "2030-01-01T00:00:00.000Z", inline: true },
    ]);
    expect(embed.footer?.text).toBe("Librariarr API Keys");
    expect(embed.timestamp).toBeTruthy();
  });

  it("reports a never-expiring key as such", () => {
    const embed = buildApiKeyEmbed("created", { ...key, expiresAt: null });
    expect(embed.fields?.find((f) => f.name === "Expires")?.value).toBe("Never");
  });

  it("announces a deleted key with its name and prefix only", () => {
    const embed = buildApiKeyEmbed("deleted", key);
    expect(embed.title).toBe("API Key Deleted");
    expect(embed.fields?.map((f) => f.name)).toEqual(["Name", "Key"]);
    expect(embed.color).not.toBe(buildApiKeyEmbed("created", key).color);
  });
});
