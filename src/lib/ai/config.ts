import { prisma } from "@/lib/db";
import { AI_PROVIDERS } from "@/lib/validation";
import type { AiConfig, AiProvider } from "./types";

const DEFAULT_BASE_URLS: Record<AiProvider, string> = {
  "openai-compatible": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

/** Default API base URL for a provider (used when the admin leaves it blank). */
export function defaultBaseUrl(provider: AiProvider): string {
  return DEFAULT_BASE_URLS[provider];
}

/** Narrow a stored provider string to the union, defaulting to openai-compatible. */
export function asProvider(value: string | null | undefined): AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value ?? "")
    ? (value as AiProvider)
    : "openai-compatible";
}

export interface AiConfigInput {
  provider: AiProvider;
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
}

/**
 * Resolve the effective connection config from stored settings (+ overrides).
 * Applies the provider default base URL and strips trailing slashes. Returns
 * null when the config is unusable (no model set).
 */
export function resolveAiConfig(input: AiConfigInput): AiConfig | null {
  const model = (input.model ?? "").trim();
  if (!model) return null;
  const baseUrl = ((input.baseUrl ?? "").trim() || defaultBaseUrl(input.provider)).replace(/\/+$/, "");
  const apiKey = (input.apiKey ?? "").trim();
  return { provider: input.provider, baseUrl, apiKey, model };
}

/** Load the saved AI settings for a user (secrets included — caller must not leak). */
export async function getStoredAiSettings(userId: string) {
  return prisma.appSettings.findUnique({
    where: { userId },
    select: {
      aiEnabled: true,
      aiProvider: true,
      aiBaseUrl: true,
      aiApiKey: true,
      aiModel: true,
    },
  });
}
