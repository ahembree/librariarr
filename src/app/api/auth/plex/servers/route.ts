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

    const servers = resources
      .filter((r) => r.provides.includes("server") && r.owned)
      .map((s) => ({
        name: s.name,
        clientIdentifier: s.clientIdentifier,
        product: s.product,
        productVersion: s.productVersion,
        platform: s.platform,
        accessToken: s.accessToken,
        connections: s.connections,
      }));

    apiLogger.info("Auth", `Found ${servers.length} owned Plex servers`);

    // accessToken is intentionally included unsanitized — the onboarding flow
    // needs it to register the server. This endpoint requires an active
    // authenticated session with a valid plexToken.
    return NextResponse.json({ servers });
  } catch (error) {
    apiLogger.error("Auth", "Failed to fetch Plex servers", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to fetch servers" },
      { status: 500 }
    );
  }
}
