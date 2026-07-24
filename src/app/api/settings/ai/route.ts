import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, aiSettingsUpdateSchema } from "@/lib/validation";
import { MASKED_VALUE } from "@/lib/api/sanitize";
import { asProvider, getStoredAiSettings } from "@/lib/ai/config";

type StoredAi = Awaited<ReturnType<typeof getStoredAiSettings>>;

/** Shape the stored settings for the client — the API key is masked, never sent. */
function shape(settings: StoredAi) {
  return {
    enabled: settings?.aiEnabled ?? false,
    provider: asProvider(settings?.aiProvider),
    baseUrl: settings?.aiBaseUrl ?? "",
    model: settings?.aiModel ?? "",
    // Masked placeholder when a key is stored; empty when none. The client
    // echoes this back on save and the PUT handler skips writing the mask.
    apiKey: settings?.aiApiKey ? MASKED_VALUE : "",
    hasApiKey: !!settings?.aiApiKey,
  };
}

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const settings = await getStoredAiSettings(session.userId!);
  return NextResponse.json(shape(settings));
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, aiSettingsUpdateSchema);
  if (error) return error;

  const current = await getStoredAiSettings(session.userId!);

  const fields: Record<string, unknown> = {};
  if (data.enabled !== undefined) fields.aiEnabled = data.enabled;
  if (data.provider !== undefined) fields.aiProvider = data.provider;
  if (data.baseUrl !== undefined) fields.aiBaseUrl = data.baseUrl || null;
  if (data.model !== undefined) fields.aiModel = data.model || null;
  // Only persist the key when a real (non-mask) value is provided; empty string
  // explicitly clears it (local models often need none).
  if (data.apiKey !== undefined && data.apiKey !== MASKED_VALUE) {
    fields.aiApiKey = data.apiKey || null;
  }

  // Don't let the assistant be enabled without a model — it would fail on first use.
  const effectiveEnabled = data.enabled ?? current?.aiEnabled ?? false;
  const effectiveModel = (data.model !== undefined ? data.model : current?.aiModel) || "";
  if (effectiveEnabled && !effectiveModel.trim()) {
    return NextResponse.json(
      { error: "Set a model before enabling the AI assistant." },
      { status: 400 },
    );
  }

  const settings = await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    update: fields,
    create: { userId: session.userId!, ...fields },
  });

  return NextResponse.json(shape(settings));
}
