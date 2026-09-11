import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { formatSessionMediaTitle } from "@/lib/media-server/session-title";
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

      // The active sessions are read even when explicit ids were given: they
      // are the only place the viewer and the media behind a session id exist,
      // and the termination log has to name both. A failure here is NOT fatal —
      // the ids are still actionable, so termination proceeds and the log falls
      // back to the bare id rather than the whole request failing over a label.
      let activeSessions: MediaSession[] = [];
      try {
        activeSessions = await client.getSessions();
      } catch (error) {
        // Without explicit ids there is nothing to terminate, so this really is
        // a connection failure — rethrow to the per-server handler below.
        if (!sessionIds) throw error;
        apiLogger.warn(
          "Tools",
          `Could not read active sessions on "${server.name}" — terminating without session detail`,
          { error: sanitizeErrorDetail(String(error)) }
        );
      }
      const byId = new Map(activeSessions.map((s) => [s.sessionId, s]));

      // If no explicit IDs were given, terminate all sessions on this server.
      let idsToTerminate = sessionIds ?? activeSessions.map((s) => s.sessionId);
      // Drop empty ids — terminating "" is a no-op that some servers answer
      // 400 to, which would surface as a spurious error.
      idsToTerminate = idsToTerminate.filter((id) => id);

      for (const sid of idsToTerminate) {
        const active = byId.get(sid);
        const username = active?.username ?? "unknown user";
        const mediaTitle = active ? formatSessionMediaTitle(active) : "unknown media";
        try {
          await client.terminateSession(sid, message);
          terminated++;
          apiLogger.info(
            "Tools",
            `Terminated session for "${username}" on "${server.name}" — ${mediaTitle} (reason: ${message})`,
            { sessionId: sid, serverId: server.id, username, mediaTitle, reason: message }
          );
        } catch (error) {
          errors.push(`Failed to terminate session ${sid} on "${server.name}": ${sanitizeErrorDetail(String(error))}`);
        }
      }
    } catch (error) {
      errors.push(`Failed to connect to server "${server.name}": ${sanitizeErrorDetail(String(error))}`);
    }
  }

  return NextResponse.json({ terminated, errors });
}
