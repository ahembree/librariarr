import { logger } from "@/lib/logger";
import { formatSessionMediaTitle, type SessionTitleParts } from "./session-title";

/**
 * One source for every termination, whichever subsystem stopped the stream.
 * Split across sources (the API route vs the enforcer), an operator auditing
 * "what stopped this stream" has to know which subsystem to look under before
 * they can find out.
 */
export const TERMINATION_SOURCE = "Streams";

export interface Termination {
  serverId: string;
  serverName: string;
  sessionId: string;
  /** What stopped it: "manual", "maintenance mode", `blackout "Weeknights"`. */
  trigger: string;
  /** The message shown to the viewer. */
  reason: string;
  /** The session, when known — absent for an id nothing has listed. */
  session?: SessionTitleParts & { username?: string };
}

function label(t: Termination) {
  return {
    // `||`: Jellyfin/Emby pass `UserName` through unfiltered, and an empty
    // name is as unusable as a missing one.
    username: t.session?.username || "unknown user",
    mediaTitle: t.session ? formatSessionMediaTitle(t.session) : "unknown media",
  };
}

/** `"alice" on "My Plex" — Breaking Bad · Pilot (session abc123)` */
function describe(t: Termination, username: string, mediaTitle: string): string {
  return `"${username}" on "${t.serverName}" — ${mediaTitle} (session ${t.sessionId})`;
}

export function logTermination(t: Termination): void {
  const { username, mediaTitle } = label(t);
  logger.info(
    TERMINATION_SOURCE,
    `Terminated session for ${describe(t, username, mediaTitle)} (trigger: ${t.trigger}, reason: ${t.reason})`,
    {
      sessionId: t.sessionId,
      serverId: t.serverId,
      username,
      mediaTitle,
      trigger: t.trigger,
      reason: t.reason,
    },
  );
}

/** Message for a termination that was attempted and failed. `detail` is sanitized by the caller. */
export function terminationFailureMessage(
  t: Termination,
  detail: string | undefined,
): string {
  const { username, mediaTitle } = label(t);
  return `Failed to terminate session for ${describe(t, username, mediaTitle)}: ${detail ?? "unknown error"}`;
}
