import { prisma } from "@/lib/db";
import { sendDiscordNotification } from "@/lib/discord/client";
import type { DeleteCeilingRunKind } from "@/lib/lifecycle/delete-ceiling";

/**
 * Discord notices for a run the deletion limits held. Shared by the scheduled
 * executor and the two hand-started paths (Execute on the Pending page and a
 * query action), so every hold is told the same way and with the webhook's own
 * name and avatar, like every other notification.
 *
 * A ceiling that silently does nothing is worse than no ceiling — the user has
 * no reason to go looking — so a hold is announced whoever started the run.
 * Best-effort: callers swallow failures, because a webhook outage must not fail
 * a lifecycle run.
 */
export async function notifyDeletionHeld(userId: string, description: string): Promise<void> {
  const settings = await prisma.appSettings.findFirst({
    where: { userId },
    select: { discordWebhookUrl: true, discordWebhookUsername: true, discordWebhookAvatarUrl: true },
  });
  if (!settings?.discordWebhookUrl) return;

  await sendDiscordNotification(settings.discordWebhookUrl, {
    username: settings.discordWebhookUsername || "Librariarr",
    avatar_url: settings.discordWebhookAvatarUrl || undefined,
    embeds: [
      {
        title: "Lifecycle deletion held for review",
        description,
        color: 0xf59e0b,
        footer: { text: "Lifecycle" },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

// A hand-started run that is held tells Discord at most once per 15 minutes:
// Execute and the public API's execute endpoint can be called in a loop, and
// each refusal would otherwise post a message. Every hold is still logged.
// Pinned to globalThis: the route bundles and the job worker load this module
// separately (see "Cross-bundle singletons" in CLAUDE.md).
const MANUAL_HOLD_NOTICE_INTERVAL_MS = 15 * 60 * 1000;
const globalForHoldNotice = globalThis as unknown as { manualHoldNoticeAt?: { at: number } };
const manualHoldNotice = (globalForHoldNotice.manualHoldNoticeAt ??= { at: 0 });

/** The notice for a run over the configured deletion limit. */
export async function notifyDeleteCeilingHeld(
  userId: string,
  verdict: { count: number; limit: number | null },
  kind: DeleteCeilingRunKind,
  source?: string,
): Promise<void> {
  if (kind === "manual") {
    if (Date.now() - manualHoldNotice.at < MANUAL_HOLD_NOTICE_INTERVAL_MS) return;
    manualHoldNotice.at = Date.now();
  }
  const what = kind === "scheduled" ? "This run" : `A run started by hand${source ? ` (${source})` : ""}`;
  const next =
    kind === "scheduled"
      ? `The actions are still pending — review them on the Pending page and execute at most ` +
        `**${verdict.limit}** at a time if they are correct, or raise the limit in Settings.`
      : `It was refused before anything ran. Run it on at most **${verdict.limit}** item(s) at a time, ` +
        `or raise the limit in Settings.`;
  await notifyDeletionHeld(
    userId,
    `${what} would have deleted **${verdict.count}** item(s), above the configured limit of ` +
      `**${verdict.limit}**.\n\nNothing was deleted. ${next}`,
  );
}

/** Test seam: forget when the last hand-started hold was announced. */
export function _resetHoldNoticeForTesting(): void {
  manualHoldNotice.at = 0;
}
