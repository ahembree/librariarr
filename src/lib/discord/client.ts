import { logger } from "@/lib/logger";

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

interface DiscordWebhookPayload {
  username?: string;
  avatar_url?: string;
  content?: string;
  embeds?: DiscordEmbed[];
}

// Discord embed field values are capped at 1024 characters.
// Build a bulleted list that fits within this limit, appending a "…and N more" suffix if truncated.
function buildTruncatedList(titles: string[], limit = 1024): string {
  const suffix = (remaining: number) => `\n*…and ${remaining} more*`;
  let value = "";
  let count = 0;

  for (const title of titles) {
    const line = `• ${title}\n`;
    // Reserve space for the potential suffix
    const remaining = titles.length - count - 1;
    const wouldNeedSuffix = remaining > 0;
    const reservedSpace = wouldNeedSuffix ? suffix(remaining).length : 0;

    if (value.length + line.length + reservedSpace > limit && count > 0) {
      value += suffix(titles.length - count);
      return value.trimEnd();
    }
    value += line;
    count++;
  }

  return value.trimEnd();
}

export async function sendDiscordNotification(
  webhookUrl: string,
  payload: DiscordWebhookPayload
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "Unknown error");
      return { ok: false, error: `Discord webhook returned ${response.status}: ${text}` };
    }
    return { ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error("Discord", `Failed to send webhook: ${msg}`);
    return { ok: false, error: msg };
  }
}

// Green for batched successes
export function buildSuccessSummaryEmbed(
  ruleSetName: string,
  actionType: string,
  titles: string[],
): DiscordEmbed {
  const actionLabels: Record<string, string> = {
    DELETE_RADARR: "Delete from Radarr",
    DELETE_SONARR: "Delete from Sonarr",
    DELETE_LIDARR: "Delete from Lidarr",
    UNMONITOR_RADARR: "Unmonitor in Radarr",
    UNMONITOR_SONARR: "Unmonitor in Sonarr",
    UNMONITOR_LIDARR: "Unmonitor in Lidarr",
    DO_NOTHING: "Monitor Only",
  };

  const fields: DiscordEmbed["fields"] = [
    { name: "Rule", value: ruleSetName, inline: true },
    { name: "Action", value: actionLabels[actionType] ?? actionType, inline: true },
    { name: "Completed", value: String(titles.length), inline: true },
  ];

  const uniqueTitles = [...new Set(titles)];
  const itemLines = uniqueTitles.map((t) => `• ${t}`);
  fields.push({ name: "Items", value: buildTruncatedList(itemLines) });

  return {
    title: `${titles.length} Action${titles.length !== 1 ? "s" : ""} Completed`,
    description: `${titles.length} lifecycle action${titles.length !== 1 ? "s" : ""} completed successfully.`,
    color: 0x22c55e,
    fields,
    footer: { text: "Librariarr Lifecycle" },
    timestamp: new Date().toISOString(),
  };
}

// Red for batched failures
export function buildFailureSummaryEmbed(
  ruleSetName: string,
  actionType: string,
  failures: { title: string; error: string }[],
): DiscordEmbed {
  const actionLabels: Record<string, string> = {
    DELETE_RADARR: "Delete from Radarr",
    DELETE_SONARR: "Delete from Sonarr",
    DELETE_LIDARR: "Delete from Lidarr",
    UNMONITOR_RADARR: "Unmonitor in Radarr",
    UNMONITOR_SONARR: "Unmonitor in Sonarr",
    UNMONITOR_LIDARR: "Unmonitor in Lidarr",
    DO_NOTHING: "Monitor Only",
  };

  const fields: DiscordEmbed["fields"] = [
    { name: "Rule", value: ruleSetName, inline: true },
    { name: "Action", value: actionLabels[actionType] ?? actionType, inline: true },
    { name: "Failed", value: String(failures.length), inline: true },
  ];

  const itemLines = [...new Set(failures.map((f) => `• ${f.title}: ${f.error}`))];
  fields.push({ name: "Items", value: buildTruncatedList(itemLines) });

  return {
    title: `${failures.length} Action${failures.length !== 1 ? "s" : ""} Failed`,
    description: `${failures.length} lifecycle action${failures.length !== 1 ? "s" : ""} failed during scheduled execution.`,
    color: 0xef4444,
    fields,
    footer: { text: "Librariarr Lifecycle" },
    timestamp: new Date().toISOString(),
  };
}

// Blue for match changes
export function buildMatchChangeEmbed(
  ruleSetName: string,
  addedCount: number,
  removedCount: number,
  type: string,
  addedTitles: string[] = [],
  removedTitles: string[] = [],
): DiscordEmbed {
  const fields: DiscordEmbed["fields"] = [];
  if (addedCount > 0) {
    fields.push({ name: "New Matches", value: String(addedCount), inline: true });
  }
  if (removedCount > 0) {
    fields.push({ name: "Removed Matches", value: String(removedCount), inline: true });
  }
  fields.push({ name: "Type", value: type, inline: true });

  if (addedTitles.length > 0) {
    fields.push({ name: "Added Items", value: buildTruncatedList(addedTitles) });
  }
  if (removedTitles.length > 0) {
    fields.push({ name: "Removed Items", value: buildTruncatedList(removedTitles) });
  }

  return {
    title: `Rule Match Update: ${ruleSetName}`,
    description: addedCount > 0 && removedCount > 0
      ? `${addedCount} new match${addedCount !== 1 ? "es" : ""} found, ${removedCount} match${removedCount !== 1 ? "es" : ""} removed.`
      : addedCount > 0
        ? `${addedCount} new match${addedCount !== 1 ? "es" : ""} found.`
        : `${removedCount} match${removedCount !== 1 ? "es" : ""} removed.`,
    color: 0x3b82f6,
    fields,
    footer: { text: "Librariarr Lifecycle" },
    timestamp: new Date().toISOString(),
  };
}

// Amber for enabled, green for disabled
export function buildMaintenanceEmbed(
  enabled: boolean,
  message?: string
): DiscordEmbed {
  return {
    title: enabled ? "Maintenance Mode Enabled" : "Maintenance Mode Disabled",
    description: enabled
      ? `Server maintenance mode has been activated.${message ? `\n\nMessage: ${message}` : ""}`
      : "Server maintenance mode has been deactivated. Streams are no longer being terminated.",
    color: enabled ? 0xf59e0b : 0x22c55e,
    footer: { text: "Librariarr Maintenance" },
    timestamp: new Date().toISOString(),
  };
}
