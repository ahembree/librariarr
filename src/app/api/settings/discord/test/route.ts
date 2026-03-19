import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { sendDiscordNotification } from "@/lib/discord/client";
import { validateRequest, discordTestSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, discordTestSchema);
  if (error) return error;
  let webhookUrl = data.webhookUrl;
  let webhookUsername: string | null | undefined = data.webhookUsername;
  let webhookAvatarUrl: string | null | undefined = data.webhookAvatarUrl;

  // Fall back to saved settings if no URL provided
  if (!webhookUrl) {
    const settings = await prisma.appSettings.findUnique({
      where: { userId: session.userId! },
    });
    if (!settings?.discordWebhookUrl) {
      return NextResponse.json(
        { success: false, error: "No webhook URL configured" },
        { status: 400 }
      );
    }
    webhookUrl = settings.discordWebhookUrl;
    webhookUsername = webhookUsername || settings.discordWebhookUsername;
    webhookAvatarUrl = webhookAvatarUrl || settings.discordWebhookAvatarUrl;
  }

  const result = await sendDiscordNotification(webhookUrl, {
    username: webhookUsername || undefined,
    avatar_url: webhookAvatarUrl || undefined,
    embeds: [
      {
        title: "Test Notification",
        description:
          "Discord webhook is configured correctly for Librariarr.",
        color: 0x3b82f6,
        footer: { text: "Librariarr" },
        timestamp: new Date().toISOString(),
      },
    ],
  });

  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error },
      { status: 502 }
    );
  }

  return NextResponse.json({ success: true });
}
