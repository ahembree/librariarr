import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, discordSettingsSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
  });

  return NextResponse.json({
    webhookUrl: settings?.discordWebhookUrl ?? "",
    webhookUsername: settings?.discordWebhookUsername ?? "",
    webhookAvatarUrl: settings?.discordWebhookAvatarUrl ?? "",
    notifyMaintenance: settings?.discordNotifyMaintenance ?? false,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, discordSettingsSchema);
  if (error) return error;
  const { webhookUrl, webhookUsername, webhookAvatarUrl, notifyMaintenance } = data;

  const fields: Record<string, unknown> = {};
  if (webhookUrl !== undefined) fields.discordWebhookUrl = webhookUrl || null;
  if (webhookUsername !== undefined) fields.discordWebhookUsername = webhookUsername || null;
  if (webhookAvatarUrl !== undefined) fields.discordWebhookAvatarUrl = webhookAvatarUrl || null;
  if (notifyMaintenance !== undefined) fields.discordNotifyMaintenance = !!notifyMaintenance;

  const settings = await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    update: fields,
    create: { userId: session.userId!, ...fields },
  });

  return NextResponse.json({
    webhookUrl: settings.discordWebhookUrl ?? "",
    webhookUsername: settings.discordWebhookUsername ?? "",
    webhookAvatarUrl: settings.discordWebhookAvatarUrl ?? "",
    notifyMaintenance: settings.discordNotifyMaintenance,
  });
}
