import { describe, it, expect, vi } from "vitest";

// config.ts imports @/lib/db for getStoredAiSettings; stub it so no client is built.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { resolveAiConfig, asProvider, defaultBaseUrl } from "@/lib/ai/config";

describe("ai/config", () => {
  describe("asProvider", () => {
    it("passes through valid providers", () => {
      expect(asProvider("openai-compatible")).toBe("openai-compatible");
      expect(asProvider("anthropic")).toBe("anthropic");
    });
    it("defaults unknown / null to openai-compatible", () => {
      expect(asProvider("gemini")).toBe("openai-compatible");
      expect(asProvider(null)).toBe("openai-compatible");
      expect(asProvider(undefined)).toBe("openai-compatible");
    });
  });

  describe("defaultBaseUrl", () => {
    it("returns the provider default", () => {
      expect(defaultBaseUrl("openai-compatible")).toBe("https://api.openai.com/v1");
      expect(defaultBaseUrl("anthropic")).toBe("https://api.anthropic.com");
    });
  });

  describe("resolveAiConfig", () => {
    it("returns null when no model", () => {
      expect(resolveAiConfig({ provider: "openai-compatible", model: "" })).toBeNull();
      expect(resolveAiConfig({ provider: "openai-compatible", model: "   " })).toBeNull();
      expect(resolveAiConfig({ provider: "anthropic" })).toBeNull();
    });

    it("applies the provider default base URL when blank", () => {
      const c = resolveAiConfig({ provider: "openai-compatible", model: "gpt-4o-mini", apiKey: "k" });
      expect(c).toEqual({
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "k",
        model: "gpt-4o-mini",
      });
    });

    it("uses an explicit base URL and strips trailing slashes", () => {
      const c = resolveAiConfig({
        provider: "openai-compatible",
        baseUrl: "http://localhost:11434/v1/",
        apiKey: "",
        model: "llama3.1",
      });
      expect(c?.baseUrl).toBe("http://localhost:11434/v1");
      expect(c?.apiKey).toBe("");
    });

    it("trims model and key", () => {
      const c = resolveAiConfig({ provider: "anthropic", model: " claude-sonnet-5 ", apiKey: " sk-ant " });
      expect(c?.model).toBe("claude-sonnet-5");
      expect(c?.apiKey).toBe("sk-ant");
      expect(c?.baseUrl).toBe("https://api.anthropic.com");
    });
  });
});
