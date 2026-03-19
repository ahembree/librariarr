import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
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

      // If terminating all sessions on this server, fetch them first
      let idsToTerminate = sessionIds;
      if (!idsToTerminate || serverId === "all") {
        const sessions = await client.getSessions();
        idsToTerminate = sessions.map((s) => s.sessionId);
      }

      for (const sid of idsToTerminate) {
        try {
          await client.terminateSession(sid, message);
          terminated++;
          apiLogger.info("Tools", `Terminated session ${sid} on "${server.name}"`, { message });
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
