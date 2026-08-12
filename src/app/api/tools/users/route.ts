import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { getPlexFriends } from "@/lib/plex/auth";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [servers, user] = await Promise.all([
    prisma.mediaServer.findMany({
      where: { userId: session.userId!, enabled: true },
      select: { type: true, url: true, accessToken: true, tlsSkipVerify: true },
    }),
    prisma.user.findUnique({
      where: { id: session.userId! },
      select: { username: true, plexToken: true },
    }),
  ]);

  const usernames = new Set<string>();

  // Include the owner/admin username
  if (user?.username) {
    usernames.add(user.username);
  }

  // For Plex servers, fetch currently-shared friends from Plex.tv
  // (replaces the old /accounts endpoint which returned historical users)
  if (user?.plexToken) {
    const friends = await getPlexFriends(user.plexToken);
    for (const name of friends) {
      usernames.add(name);
    }
  }

  for (const server of servers) {
    try {
      const client = createMediaServerClient(server.type, server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });

      if (client.listUsernames) {
        // Jellyfin/Emby: enumerate ALL server users so offline users can be
        // excluded, not just whoever is currently streaming.
        for (const name of await client.listUsernames()) {
          usernames.add(name);
        }
      } else {
        // Plex: friends are already fetched above; the live sessions are a
        // supplementary source (e.g. the managed/home users not in friends).
        const sessions = await client.getSessions();
        for (const s of sessions) {
          if (s.username) usernames.add(s.username);
        }
      }
    } catch {
      // Skip unreachable servers
    }
  }

  return NextResponse.json({
    users: Array.from(usernames).sort((a, b) => a.localeCompare(b)),
  });
}
