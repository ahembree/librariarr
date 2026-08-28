import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { getPlexFriends } from "@/lib/plex/auth";
import { apiLogger } from "@/lib/logger";

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

  // Include the owner/admin username.
  if (user?.username) {
    usernames.add(user.username);
  }

  // Plex.tv friends are a *supplement*, never the sole source: the endpoint
  // only covers account-level "friends" (not Plex Home/managed users) and has
  // returned nothing for some setups. The server's own account list (below) is
  // the reliable enumeration.
  let plexFriendCount = 0;
  if (user?.plexToken) {
    const friends = await getPlexFriends(user.plexToken);
    plexFriendCount = friends.length;
    for (const name of friends) {
      usernames.add(name);
    }
  }

  for (const server of servers) {
    try {
      const client = createMediaServerClient(server.type, server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });

      // Enumerate every user the server knows about so offline users can be
      // excluded, not just whoever is streaming right now. Jellyfin/Emby list
      // `/Users`; Plex lists `/accounts` (every account that has streamed).
      // Guarded on its own so a failure here still lets the live-session pass
      // below run — otherwise an /accounts hiccup would drop even the users who
      // are streaming, which is the very regression this route must avoid.
      if (client.listUsernames) {
        try {
          for (const name of await client.listUsernames()) {
            usernames.add(name);
          }
        } catch (error) {
          apiLogger.debug("Users", `Could not list users for "${server.type}" server`, {
            error: String(error),
          });
        }
      }

      // Always also add currently-streaming users. Redundant with the
      // enumeration in the common case, but it's the fallback when enumeration
      // is unavailable or incomplete, and guarantees a live session is never
      // missing from the picker.
      try {
        const sessions = await client.getSessions();
        for (const s of sessions) {
          if (s.username) usernames.add(s.username);
        }
      } catch (error) {
        apiLogger.debug("Users", `Could not read sessions for "${server.type}" server`, {
          error: String(error),
        });
      }
    } catch {
      // Skip unreachable servers.
    }
  }

  apiLogger.debug("Users", "Resolved excluded-user candidates", {
    total: usernames.size,
    plexFriends: plexFriendCount,
    servers: servers.length,
  });

  return NextResponse.json({
    users: Array.from(usernames).sort((a, b) => a.localeCompare(b)),
  });
}
