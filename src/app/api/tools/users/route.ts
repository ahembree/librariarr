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

  // Every lookup at once — plex.tv's friends and, per server, its user list and
  // its sessions — rather than one after another: each is a network round trip
  // (plex.tv's, or a media server's), and the picker waited for their sum. The
  // list is sorted at the end, so the order the names arrive in changes nothing.
  //
  // Plex.tv friends are a *supplement*, never the sole source: the endpoint
  // only covers account-level "friends" (not Plex Home/managed users) and has
  // returned nothing for some setups. The server's own account list (below) is
  // the reliable enumeration.
  const friendsLookup = user?.plexToken ? getPlexFriends(user.plexToken) : Promise.resolve([]);

  const serverLookups = servers.flatMap((server) => {
    let client: ReturnType<typeof createMediaServerClient>;
    try {
      client = createMediaServerClient(server.type, server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });
    } catch {
      // Skip a server whose client cannot be built.
      return [];
    }

    return [
      // Enumerate every user the server knows about so offline users can be
      // excluded, not just whoever is streaming right now. Jellyfin/Emby list
      // `/Users`; Plex lists `/accounts` (every account that has streamed).
      // Settled on its own so a failure here still lets the live-session
      // lookup count — otherwise an /accounts hiccup would drop even the users
      // who are streaming, which is the very regression this route must avoid.
      (client.listUsernames ? client.listUsernames() : Promise.resolve([])).catch((error: unknown) => {
        apiLogger.debug("Users", `Could not list users for "${server.type}" server`, {
          error: String(error),
        });
        return [] as string[];
      }),
      // Always also add currently-streaming users. Redundant with the
      // enumeration in the common case, but it's the fallback when enumeration
      // is unavailable or incomplete, and guarantees a live session is never
      // missing from the picker.
      client
        .getSessions()
        .then((sessions) => sessions.flatMap((s) => (s.username ? [s.username] : [])))
        .catch((error: unknown) => {
          apiLogger.debug("Users", `Could not read sessions for "${server.type}" server`, {
            error: String(error),
          });
          return [] as string[];
        }),
    ];
  });

  const [friends, ...serverNames] = await Promise.all([friendsLookup, ...serverLookups]);
  const plexFriendCount = friends.length;
  for (const name of friends) usernames.add(name);
  for (const names of serverNames) for (const name of names) usernames.add(name);

  apiLogger.debug("Users", "Resolved excluded-user candidates", {
    total: usernames.size,
    plexFriends: plexFriendCount,
    servers: servers.length,
  });

  return NextResponse.json({
    users: Array.from(usernames).sort((a, b) => a.localeCompare(b)),
  });
}
