import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { PlexClient } from "@/lib/plex/client";

/**
 * Fetch the current Plex visibility state for a rule set's collection.
 * Returns the actual state from Plex (not the DB).
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const ruleSetId = searchParams.get("ruleSetId");
  if (!ruleSetId) {
    return NextResponse.json(
      { error: "ruleSetId is required" },
      { status: 400 }
    );
  }

  const ruleSet = await prisma.ruleSet.findUnique({
    where: { id: ruleSetId, userId: session.userId },
  });

  if (!ruleSet || !ruleSet.collectionName) {
    return NextResponse.json({ home: false, recommended: false });
  }

  const libraryType = ruleSet.type === "MOVIE" ? "MOVIE" : "SERIES";
  const userLibraries = await prisma.library.findMany({
    where: {
      mediaServer: { userId: session.userId, type: "PLEX" },
      type: libraryType,
    },
    include: { mediaServer: true },
  });

  // Check visibility on the first library where the collection exists
  for (const library of userLibraries) {
    if (!library.mediaServer?.machineId) continue;
    const server = library.mediaServer;
    if (!server) continue;

    try {
      const client = new PlexClient(server.url, server.accessToken, {
        skipTlsVerify: server.tlsSkipVerify,
      });

      const collections = await client.getCollections(library.key);
      const collection = collections.find(
        (c) => c.title === ruleSet.collectionName
      );
      if (!collection) continue;

      const visibility = await client.getCollectionVisibility(
        library.key,
        collection.ratingKey
      );

      return NextResponse.json({
        home: visibility.home,
        recommended: visibility.recommended,
      });
    } catch {
      // Try next library
      continue;
    }
  }

  // Collection not found in any library
  return NextResponse.json({ home: false, recommended: false });
}
