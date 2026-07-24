import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { validateRequest, aiChatSchema } from "@/lib/validation";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";
import { progressStreamResponse } from "@/lib/progress/stream";
import type { ProgressEmit } from "@/lib/progress/types";
import { asProvider, getStoredAiSettings, resolveAiConfig } from "@/lib/ai/config";
import { runAnalyst } from "@/lib/ai/analyst";
import type { AiStreamEvent } from "@/lib/ai/types";

// Streaming + potentially slow (local models, multi-tool loops). Force dynamic
// and cap the duration so a request can't pin a function forever.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const rateLimited = checkAuthRateLimit(request, "ai-chat");
  if (rateLimited) return rateLimited;

  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, aiChatSchema);
  if (error) return error;

  const stored = await getStoredAiSettings(session.userId!);
  if (!stored?.aiEnabled) {
    return NextResponse.json(
      { error: "The AI assistant is disabled. Enable it under Settings → AI." },
      { status: 400 },
    );
  }

  const config = resolveAiConfig({
    provider: asProvider(stored.aiProvider),
    baseUrl: stored.aiBaseUrl,
    apiKey: stored.aiApiKey,
    model: stored.aiModel,
  });
  if (!config) {
    return NextResponse.json(
      { error: "The AI assistant isn't fully configured — set a model under Settings → AI." },
      { status: 400 },
    );
  }

  const userId = session.userId!;
  // Stream status/tool events, then the final { answer, evidence } as the
  // terminal result. request.signal aborts the run on client disconnect.
  return progressStreamResponse(
    (emit: ProgressEmit, signal) =>
      runAnalyst(
        { userId, config, messages: data.messages },
        emit as unknown as (event: AiStreamEvent) => void,
        signal,
      ),
    { signal: request.signal },
  );
}
