import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { PlexClient } from "@/lib/plex/client";
import { validateRequest, prerollPathSchema } from "@/lib/validation";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [servers, presets, schedules] = await Promise.all([
    prisma.mediaServer.findMany({
      where: { userId: session.userId!, type: "PLEX", enabled: true },
      select: { id: true, url: true, accessToken: true, tlsSkipVerify: true },
    }),
    prisma.prerollPreset.findMany({
      where: { userId: session.userId! },
      orderBy: { createdAt: "desc" },
    }),
    prisma.prerollSchedule.findMany({
      where: { userId: session.userId! },
      orderBy: { priority: "desc" },
    }),
  ]);

  let currentPreroll = "";
  if (servers.length > 0) {
    try {
      const client = new PlexClient(servers[0].url, servers[0].accessToken, {
        skipTlsVerify: servers[0].tlsSkipVerify,
      });
      currentPreroll = await client.getPrerollSetting();
    } catch {
      /* ignore */
    }
  }

  return NextResponse.json({ currentPreroll, presets, schedules, hasPlexServers: servers.length > 0 });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, prerollPathSchema);
  if (error) return error;
  const { path } = data;

  const servers = await prisma.mediaServer.findMany({
    where: { userId: session.userId!, type: "PLEX", enabled: true },
  });
  const errors: string[] = [];

  for (const server of servers) {
    try {
      const client = new PlexClient(server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });
      if (path === "") {
        await client.clearPreroll();
      } else {
        await client.setPrerollPath(path);
      }
    } catch (error) {
      errors.push(
        `${server.name}: ${sanitizeErrorDetail(error instanceof Error ? error.message : "Unknown error")}`
      );
    }
  }

  return NextResponse.json({ success: errors.length === 0, errors });
}
