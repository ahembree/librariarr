import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { buildApiKeyEmbed, sendDiscordNotification, type ApiKeyEmbedKey } from "@/lib/discord/client";

/**
 * Tell Discord an API key was created or deleted, when a webhook is set and
 * `discordNotifyApiKeys` is on (the default). A key outlives the browser
 * session that minted it and survives a password change, so its creation is
 * the one event that reveals a session someone else got hold of — and the
 * admin has to hear it somewhere other than the settings page they are not
 * looking at. Never throws and never blocks the request: the caller fires it
 * and moves on.
 */
export async function notifyApiKeyChange(
  userId: string,
  event: "created" | "deleted",
  key: ApiKeyEmbedKey,
): Promise<void> {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { userId },
      select: {
        discordWebhookUrl: true,
        discordWebhookUsername: true,
        discordWebhookAvatarUrl: true,
        discordNotifyApiKeys: true,
      },
    });
    if (!settings?.discordWebhookUrl || !settings.discordNotifyApiKeys) return;
    await sendDiscordNotification(settings.discordWebhookUrl, {
      username: settings.discordWebhookUsername || "Librariarr",
      avatar_url: settings.discordWebhookAvatarUrl || undefined,
      embeds: [buildApiKeyEmbed(event, key)],
    });
  } catch (error) {
    logger.warn("Auth", `Could not send the Discord notification for an API key ${event}`, {
      error: String(error),
    });
  }
}
