import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { validateRequest, aiTestSchema } from "@/lib/validation";
import { sanitizeErrorDetail, MASKED_VALUE } from "@/lib/api/sanitize";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";
import { getStoredAiSettings, resolveAiConfig } from "@/lib/ai/config";
import { createProvider } from "@/lib/ai/provider";
import { refuseStoredKeyToNewUrl } from "@/lib/integrations/stored-key-guard";

/**
 * Test an AI connection. Uses the provided config; a masked/omitted API key or
 * base URL falls back to the saved value so the admin can re-test without
 * re-entering the key. Rate-limited because it makes an outbound request.
 * Sending the saved key to a base URL other than the saved one needs a recent
 * sign-in, as for every integration's stored key (stored-key-guard.ts).
 */
export async function POST(request: NextRequest) {
  const rateLimited = checkAuthRateLimit(request, "ai-test");
  if (rateLimited) return rateLimited;

  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, aiTestSchema);
  if (error) return error;

  const stored = await getStoredAiSettings(session.userId!);
  const usesStoredKey = data.apiKey === undefined || data.apiKey === MASKED_VALUE;
  if (usesStoredKey && stored?.aiApiKey) {
    const refused = await refuseStoredKeyToNewUrl(session, stored.aiBaseUrl ?? "", data.baseUrl, undefined, "the AI provider");
    if (refused) return refused;
  }
  const apiKey = usesStoredKey ? stored?.aiApiKey ?? "" : data.apiKey!;
  const baseUrl = data.baseUrl !== undefined ? data.baseUrl : stored?.aiBaseUrl ?? "";

  const config = resolveAiConfig({ provider: data.provider, baseUrl, apiKey, model: data.model });
  if (!config) {
    return NextResponse.json({ ok: false, error: "Model is required" }, { status: 400 });
  }

  const provider = createProvider(config);
  const result = await provider.testConnection();
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: sanitizeErrorDetail(result.error) });
  }
  return NextResponse.json({ ok: true, model: result.model });
}
