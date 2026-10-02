import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getPlexResources } from "@/lib/plex/auth";
import { apiLogger } from "@/lib/logger";

export async function GET() {
  try {
    const session = await getSession();

    if (!session.isLoggedIn || !session.plexToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const resources = await getPlexResources(session.plexToken);

    // No `accessToken`: for a server the account owns, plex.tv can hand out
    // the account's own token here, and a Plex token signs in to Librariarr
    // (`POST /api/auth/plex/token`) with a fresh `authenticatedAt` — so any
    // cookie that could read this list could pass every recent-login check.
    // Adding a discovered server sends only its machine id; `POST
    // /api/servers` looks the token up itself, behind a recent sign-in.
    const servers = resources
      .filter((r) => r.provides.includes("server") && r.owned)
      .map((s) => ({
        name: s.name,
        clientIdentifier: s.clientIdentifier,
        product: s.product,
        productVersion: s.productVersion,
        platform: s.platform,
        connections: s.connections,
      }));

    apiLogger.info("Auth", `Found ${servers.length} owned Plex servers`);

    return NextResponse.json({ servers });
  } catch (error) {
    apiLogger.error("Auth", "Failed to fetch Plex servers", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to fetch servers" },
      { status: 500 }
    );
  }
}
