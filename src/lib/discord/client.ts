import { logger } from "@/lib/logger";
import { formatActionLabel } from "@/lib/lifecycle/action-types";

const WEBHOOK_TIMEOUT_MS = 15_000;

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

/** Longest title a notification list shows; the rest is cut with an ellipsis. */
const MAX_LIST_ITEM_LENGTH = 200;
/**
 * A failed action's line is its title and the reason it failed, cut
 * separately: cut together, a long title left none of the reason.
 */
const MAX_FAILURE_TITLE_LENGTH = 120;
const MAX_FAILURE_ERROR_LENGTH = 600;

/**
 * Text this app did not write, as Discord shows it literally.
 *
 * Embed text is Markdown, and what goes into it — a media title, an Arr
 * instance's error message — comes from the media server, a metadata agent or
 * another application. An item titled `[Librariarr: sign in again](https://…)`
 * arrived in the admin's channel as a link reading "Librariarr: sign in
 * again". Every character Markdown gives a meaning is escaped, a bare URL is
 * broken so it is not turned into a link, and line breaks are flattened so one
 * item cannot pose as several lines.
 */
export function escapeDiscordMarkdown(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/[\\*_~`|>\[\]()#<@]/g, "\\$&")
    // A zero-width space after the scheme: looks the same, is not a link.
    .replace(/:\/\//g, ":\u200b//");
}

/** `text` cut to `max` characters — code points, so never half an emoji. */
function cutText(text: string, max: number): string {
  // UTF-16 length is never less than the number of code points.
  if (text.length <= max) return text;
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max).join("")}…` : text;
}

/**
 * Escaped text cut to at most `max` UTF-16 units without leaving half a
 * surrogate pair or a lone escape character at the end.
 */
function fitEscaped(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max));
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  const trailingBackslashes = cut.match(/\\+$/)?.[0].length ?? 0;
  if (trailingBackslashes % 2 === 1) cut = cut.slice(0, -1);
  return cut;
}

// Discord embed field values are capped at 1024 characters.
// Build a bulleted list that fits within this limit, appending a "…and N more" suffix if truncated.
// Items are escaped here (`escapeDiscordMarkdown`): pass them as plain text.
// Each is cut to `itemLimit` characters first; pass Infinity for items the
// caller has already bounded.
function buildTruncatedList(titles: string[], limit = 1024, itemLimit = MAX_LIST_ITEM_LENGTH): string {
  const suffix = (remaining: number) => `\n*…and ${remaining} more*`;
  let value = "";
  let count = 0;

  for (const title of titles) {
    // Reserve space for the potential suffix
    const remaining = titles.length - count - 1;
    const wouldNeedSuffix = remaining > 0;
    const reservedSpace = wouldNeedSuffix ? suffix(remaining).length : 0;
    // Escaping can double an item's length: one item alone must still fit the
    // field, or Discord refuses the whole notification.
    const room = limit - reservedSpace - "• …\n".length;
    const escaped = escapeDiscordMarkdown(cutText(title, itemLimit));
    const line = escaped.length > room ? `• ${fitEscaped(escaped, room)}…\n` : `• ${escaped}\n`;

    if (value.length + line.length + reservedSpace > limit && count > 0) {
      value += suffix(titles.length - count);
      return value.trimEnd();
    }
    value += line;
    count++;
  }

  return value.trimEnd();
}

/**
 * Longest rate-limit wait (a 429's `retry_after`) honoured before the one
 * retry. Discord limits a webhook to about five requests every two seconds,
 * and the scheduled executor posts a success and a failure summary per rule
 * set back to back, so the later ones were refused and lost. A longer wait (a
 * global or sustained limit) is not worth holding the caller for.
 */
const MAX_RATE_LIMIT_WAIT_MS = 5_000;

type WebhookAttempt =
  | { ok: true }
  | { ok: false; error: string; status?: number; retryAfterMs?: number };

/** The wait a 429 asks for: the body's `retry_after` (seconds), else the `Retry-After` header. */
function rateLimitWaitMs(response: Response, body: string): number | undefined {
  let seconds: number | undefined;
  try {
    const parsed = JSON.parse(body) as { retry_after?: unknown } | null;
    if (typeof parsed?.retry_after === "number") seconds = parsed.retry_after;
  } catch {
    // Not JSON — fall back to the header.
  }
  if (seconds === undefined) {
    const header = response.headers?.get?.("retry-after");
    if (header) seconds = Number(header);
  }
  return seconds !== undefined && Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds * 1000)
    : undefined;
}

async function postWebhook(webhookUrl: string, payload: DiscordWebhookPayload): Promise<WebhookAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "Unknown error");
      return {
        ok: false,
        error: `Discord webhook returned ${response.status}: ${text}`,
        status: response.status,
        ...(response.status === 429 ? { retryAfterMs: rateLimitWaitMs(response, text) } : {}),
      };
    }
    return { ok: true };
  } catch (error) {
    const msg = error instanceof Error
      ? (error.name === "AbortError" ? "Discord webhook timed out" : error.message)
      : "Unknown error";
    logger.error("Discord", `Failed to send webhook: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendDiscordNotification(
  webhookUrl: string,
  payload: DiscordWebhookPayload
): Promise<{ ok: boolean; error?: string }> {
  let result = await postWebhook(webhookUrl, payload);
  if (!result.ok && result.retryAfterMs !== undefined && result.retryAfterMs <= MAX_RATE_LIMIT_WAIT_MS) {
    const wait = result.retryAfterMs;
    await new Promise((resolve) => setTimeout(resolve, wait));
    result = await postWebhook(webhookUrl, payload);
  }
  if (result.ok) return { ok: true };
  // Every lifecycle and API-key caller discards the result, so without this a
  // rate-limited, deleted (404) or refused (400) webhook dropped notifications
  // with no trace at all. Never the URL: it is the webhook's credential.
  if (result.status !== undefined) {
    logger.warn("Discord", `Notification not delivered: ${result.error.slice(0, 300)}`);
  }
  return { ok: false, error: result.error };
}

// Green for batched successes
export function buildSuccessSummaryEmbed(
  ruleSetName: string,
  actionType: string,
  titles: string[],
): DiscordEmbed {
  const fields: DiscordEmbed["fields"] = [
    { name: "Rule", value: escapeDiscordMarkdown(ruleSetName), inline: true },
    { name: "Action", value: formatActionLabel(actionType), inline: true },
    { name: "Completed", value: String(titles.length), inline: true },
  ];

  // Plain titles: `buildTruncatedList` adds the bullet (a "• " here made every line "• • title").
  fields.push({ name: "Items", value: buildTruncatedList([...new Set(titles)]) });

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
  const fields: DiscordEmbed["fields"] = [
    { name: "Rule", value: escapeDiscordMarkdown(ruleSetName), inline: true },
    { name: "Action", value: formatActionLabel(actionType), inline: true },
    { name: "Failed", value: String(failures.length), inline: true },
  ];

  // No bullet here: `buildTruncatedList` adds it. Title and reason are cut
  // separately, so the reason survives a long title.
  const itemLines = [
    ...new Set(
      failures.map(
        (f) => `${cutText(f.title, MAX_FAILURE_TITLE_LENGTH)}: ${cutText(f.error, MAX_FAILURE_ERROR_LENGTH)}`,
      ),
    ),
  ];
  fields.push({ name: "Items", value: buildTruncatedList(itemLines, 1024, Number.POSITIVE_INFINITY) });

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
    title: `Rule Match Update: ${escapeDiscordMarkdown(ruleSetName)}`,
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

/**
 * An API key was created or deleted. Sent whenever a webhook is set and
 * `discordNotifyApiKeys` is on (the default): a key outlives the browser
 * session that minted it, so this is the one notice that reveals a session
 * someone else got hold of. Blue for created, grey for deleted; never the key.
 */
/** The fields of an API key a created/deleted notification shows. */
export interface ApiKeyEmbedKey {
  name: string;
  prefix: string;
  scopes: readonly string[];
  expiresAt: Date | null;
}

export function buildApiKeyEmbed(event: "created" | "deleted", key: ApiKeyEmbedKey): DiscordEmbed {
  const created = event === "created";
  return {
    title: created ? "API Key Created" : "API Key Deleted",
    description: created
      ? `A new key for the public API was created. If you did not do this, delete it under Settings → Authentication → API Keys and review who has access to your Librariarr login.`
      : "An API key was deleted. Anything that was using it has lost access.",
    color: created ? 0x3b82f6 : 0x6b7280,
    fields: [
      { name: "Name", value: escapeDiscordMarkdown(key.name), inline: true },
      { name: "Key", value: `${key.prefix}…`, inline: true },
      ...(created
        ? [
            { name: "Scopes", value: key.scopes.join(", ") || "none", inline: false },
            {
              name: "Expires",
              value: key.expiresAt ? key.expiresAt.toISOString() : "Never",
              inline: true,
            },
          ]
        : []),
    ],
    footer: { text: "Librariarr API Keys" },
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
      ? `Server maintenance mode has been activated.${message ? `\n\nMessage: ${escapeDiscordMarkdown(message)}` : ""}`
      : "Server maintenance mode has been deactivated. Streams are no longer being terminated.",
    color: enabled ? 0xf59e0b : 0x22c55e,
    footer: { text: "Librariarr Maintenance" },
    timestamp: new Date().toISOString(),
  };
}
