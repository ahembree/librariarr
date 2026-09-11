import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { formatSessionMediaTitle } from "@/lib/media-server/session-title";
import { getRememberedSession, rememberSession } from "@/lib/media-server/session-first-seen";
import type { MediaSession } from "@/lib/media-server/types";
import { apiLogger } from "@/lib/logger";
import { validateRequest, terminateSessionSchema } from "@/lib/validation";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, terminateSessionSchema);
  if (error) return error;
  const { serverId, sessionIds, message } = data;

  // Explicit session IDs must be scoped to a single server — they're only
  // meaningful for the server that issued them. Passing serverId "all" with
  // sessionIds would otherwise try those IDs against every server.
  if (serverId === "all" && sessionIds) {
    return NextResponse.json(
      { error: "Cannot specify sessionIds when serverId is \"all\"" },
      { status: 400 }
    );
  }

  const servers = await prisma.mediaServer.findMany({
    where: {
      userId: session.userId!,
      enabled: true,
      ...(serverId !== "all" && { id: serverId }),
    },
    select: { id: true, name: true, url: true, accessToken: true, tlsSkipVerify: true, type: true },
  });

  let terminated = 0;
  const errors: string[] = [];

  for (const server of servers) {
    try {
      const client = createMediaServerClient(server.type, server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });

      // A termination has to be accountable — who was watching what, and under
      // which message — but the ids the caller sends carry none of that. The
      // label is read from what the listing routes last saw (the Stream Manager
      // lists sessions before you can select any, and its stream refreshes
      // every few seconds), NOT by fetching the session list here: that call's
      // failure mode is the problem. A network error on it opens the shared
      // per-baseURL circuit breaker, and the termination that follows is then
      // refused by the request interceptor for 45s without reaching the server.
      // A log label must never cost the operator the ability to stop a stream.
      let idsToTerminate: string[];
      const byId = new Map<string, MediaSession>();

      if (sessionIds) {
        idsToTerminate = sessionIds;
      } else {
        // With no explicit ids, everything playing is the target — that listing
        // is required regardless, so it also supplies the labels first-hand.
        const activeSessions = await client.getSessions();
        for (const s of activeSessions) {
          rememberSession(server.id, s);
          byId.set(s.sessionId, s);
        }
        idsToTerminate = activeSessions.map((s) => s.sessionId);
      }

      // Drop empty ids — terminating "" is a no-op that some servers answer
      // 400 to, which would surface as a spurious error.
      idsToTerminate = idsToTerminate.filter((id) => id);

      for (const sid of idsToTerminate) {
        const active = byId.get(sid) ?? getRememberedSession(server.id, sid);
        // `||`, not `??`: an empty username is as unusable as a missing one,
        // and Jellyfin/Emby pass `UserName` through unfiltered.
        const username = active?.username || "unknown user";
        const mediaTitle = active ? formatSessionMediaTitle(active) : "unknown media";
        // The id stays in the text: without it two unlabelled terminations in
        // one request log byte-identical lines, and `meta` is not covered by
        // the System Logs search filter.
        const who = `"${username}" on "${server.name}" — ${mediaTitle} (session ${sid})`;
        try {
          await client.terminateSession(sid, message);
          terminated++;
          apiLogger.info(
            "Tools",
            `Terminated session for ${who} (reason: ${message})`,
            { sessionId: sid, serverId: server.id, username, mediaTitle, reason: message }
          );
        } catch (error) {
          // A termination that was supposed to happen and did not is the case
          // most needing accounting, so it names the viewer and media too.
          errors.push(`Failed to terminate session for ${who}: ${sanitizeErrorDetail(String(error))}`);
        }
      }
    } catch (error) {
      errors.push(`Failed to connect to server "${server.name}": ${sanitizeErrorDetail(String(error))}`);
    }
  }

  return NextResponse.json({ terminated, errors });
}
