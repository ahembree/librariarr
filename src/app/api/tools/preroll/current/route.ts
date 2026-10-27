import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { PlexClient } from "@/lib/plex/client";
import { isUnreachable } from "@/lib/media-server/health-cache";

export const GET = withSession(async (session) => {
  const server = await prisma.mediaServer.findFirst({
    where: { userId: session.userId, type: "PLEX", enabled: true },
    select: { url: true, accessToken: true, tlsSkipVerify: true },
  });

  if (!server) {
    return NextResponse.json({ currentPreroll: "", available: false });
  }

  if (isUnreachable(server.url)) {
    return NextResponse.json({ currentPreroll: "", available: false });
  }

  try {
    const client = new PlexClient(server.url, server.accessToken, {
      skipTlsVerify: server.tlsSkipVerify,
    });
    const currentPreroll = await client.getPrerollSetting();
    return NextResponse.json({ currentPreroll, available: true });
  } catch {
    return NextResponse.json({ currentPreroll: "", available: false });
  }
});
