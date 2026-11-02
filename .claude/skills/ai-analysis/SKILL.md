---
name: ai-analysis
description: The AI Analysis assistant — provider-neutral client (OpenAI-compatible and Anthropic), read-only tools, grounding, the tool-calling loop and its routes. Use when changing anything under src/lib/ai or the AI settings and chat routes.
---

# AI Analysis

Read-only natural-language assistant over the library (`/tools/ai`, `src/lib/ai/`), configured in Settings → AI (`AppSettings.aiEnabled/aiProvider/aiBaseUrl/aiApiKey/aiModel`).

- **Provider-neutral, no SDK**: `provider.ts` is a thin axios client for `openai-compatible` (OpenAI, Ollama, LM Studio, OpenRouter, Groq, vLLM, LocalAI, …) and native `anthropic`. `aiBaseUrl` is admin-set (no SSRF block — local models live on private IPs).
- **Safety model**: the model can call only the fixed read-only tools in `tools.ts` (no mutating tools); tools take structured, Zod-shaped args (never model-written SQL) and delegate to `src/lib/media/*` + `executeQuery`, inheriting scoping and dedup. `search_media` excludes Arr/Seerr fields (vacuous-match hazard). The system prompt treats tool-result text as data.
- **Grounding**: `system-prompt.ts` is built from the field/dimension registries and forbids inventing numbers; scope is the user's library and watch history only.
- **Orchestration**: `analyst.ts` runs a bounded (≤ 6 iterations) tool-calling loop, streaming `status`/`tool` events via `progressStreamResponse`, returning `{ answer, evidence }`. Routes: `GET/PUT /api/settings/ai` (key masked; PUT skips `MASKED_VALUE`; can't enable without a model), `POST /api/settings/ai/test` (rate-limited), `POST /api/ai/chat` (streaming, `aiRateLimiter`, requires enabled + configured). `config.ts` resolves the config.
