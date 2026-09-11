import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { getRememberedSession, rememberSession } from "@/lib/media-server/session-first-seen";
import { logTermination, terminationFailureMessage } from "@/lib/media-server/termination-log";
import type { MediaSession } from "@/lib/media-server/types";
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

      // Labels come from what the listing routes last saw, not from a fetch
      // here: a network error on that fetch opens the shared circuit breaker
      // (see session-first-seen.ts), and the termination right after it is then
      // refused without reaching the server. A log label must never cost the
      // operator the ability to stop a stream.
      let idsToTerminate: string[];
      const byId = new Map<string, MediaSession>();

      if (sessionIds) {
        idsToTerminate = sessionIds;
      } else {
        // Terminating everything needs the listing anyway, so it also supplies
        // the labels first-hand.
        const activeSessions = await client.getSessions();
        for (const s of activeSessions) {
          rememberSession(server.id, s);
          byId.set(s.sessionId, s);
        }
        idsToTerminate = activeSessions.map((s) => s.sessionId);
      }

      // Terminating "" is a no-op some servers answer 400 to.
      idsToTerminate = idsToTerminate.filter((id) => id);

      for (const sid of idsToTerminate) {
        const termination = {
          serverId: server.id,
          serverName: server.name,
          sessionId: sid,
          trigger: "manual",
          reason: message,
          session: byId.get(sid) ?? getRememberedSession(server.id, sid),
        };
        try {
          await client.terminateSession(sid, message);
          terminated++;
          logTermination(termination);
        } catch (error) {
          errors.push(terminationFailureMessage(termination, sanitizeErrorDetail(String(error))));
        }
      }
    } catch (error) {
      errors.push(`Failed to connect to server "${server.name}": ${sanitizeErrorDetail(String(error))}`);
    }
  }

  return NextResponse.json({ terminated, errors });
}
