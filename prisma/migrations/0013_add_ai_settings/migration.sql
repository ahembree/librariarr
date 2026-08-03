-- AI analysis assistant configuration on AppSettings. Provider-neutral so any
-- backend works: "openai-compatible" (OpenAI, Ollama, LM Studio, OpenRouter,
-- Groq, vLLM, LocalAI, ...) or "anthropic" (native Claude Messages API).
-- Disabled by default; aiBaseUrl overrides the provider default (required for
-- local models); aiApiKey is optional (local models often need none) and is
-- masked in API responses. Defaults preserve existing rows (feature off).

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN "aiEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AppSettings" ADD COLUMN "aiProvider" TEXT NOT NULL DEFAULT 'openai-compatible';
ALTER TABLE "AppSettings" ADD COLUMN "aiBaseUrl" TEXT;
ALTER TABLE "AppSettings" ADD COLUMN "aiApiKey" TEXT;
ALTER TABLE "AppSettings" ADD COLUMN "aiModel" TEXT;
