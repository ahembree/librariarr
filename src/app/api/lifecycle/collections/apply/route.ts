import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { PlexClient } from "@/lib/plex/client";
import { removePlexCollection } from "@/lib/lifecycle/collections";
import { logger } from "@/lib/logger";
import { validateRequest, collectionApplySchema } from "@/lib/validation";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

/**
 * Apply Plex collection changes after a rule set save.
 * Handles: disable (remove), rename, sync items, sort title, visibility.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, collectionApplySchema);
  if (error) return error;

  const { ruleSetId, previousCollectionEnabled, previousCollectionName, skipCollectionRemoval } = data;

  const ruleSet = await prisma.ruleSet.findUnique({
    where: { id: ruleSetId, userId: session.userId },
    include: {
      user: {
        include: { mediaServers: { where: { enabled: true }, select: { id: true } } },
      },
    },
  });

  if (!ruleSet) {
    return NextResponse.json({ error: "Rule set not found" }, { status: 404 });
  }

  const changes: string[] = [];

  try {
    // Case 1: Collection sync was just disabled — remove collection from Plex (unless user opted to keep it)
    if (!ruleSet.collectionEnabled && previousCollectionEnabled && previousCollectionName) {
      if (skipCollectionRemoval) {
        changes.push(`Collection "${previousCollectionName}" kept on Plex`);
      } else {
        await removePlexCollection(ruleSet.userId, ruleSet.type, previousCollectionName);
        changes.push(`Removed collection "${previousCollectionName}"`);
      }
      return NextResponse.json({ success: true, changes });
    }

    // If collection sync is not enabled, nothing to do
    if (!ruleSet.collectionEnabled || !ruleSet.collectionName) {
      return NextResponse.json({ success: true, changes });
    }

    // Case 2: Collection name was changed — rename existing collection
    if (
      previousCollectionEnabled &&
      previousCollectionName &&
      previousCollectionName !== ruleSet.collectionName
    ) {
      await renameCollectionInPlex(
        ruleSet.userId,
        ruleSet.type,
        previousCollectionName,
        ruleSet.collectionName
      );
      changes.push(
        `Renamed collection "${previousCollectionName}" → "${ruleSet.collectionName}"`
      );
    }

    return NextResponse.json({ success: true, changes });
  } catch (error) {
    logger.error("Lifecycle", "Failed to apply Plex collection changes", {
      error: String(error),
    });
    return NextResponse.json(
      { error: sanitizeErrorDetail(error instanceof Error ? error.message : "Failed to apply Plex changes") },
      { status: 500 }
    );
  }
}

/**
 * Rename an existing Plex collection across all relevant libraries.
 */
async function renameCollectionInPlex(
  userId: string,
  type: string,
  oldName: string,
  newName: string
) {
  const libraryType = type === "MOVIE" ? "MOVIE" : type === "MUSIC" ? "MUSIC" : "SERIES";
  const userLibraries = await prisma.library.findMany({
    where: {
      mediaServer: { userId, type: "PLEX" },
      type: libraryType,
    },
    include: { mediaServer: true },
  });

  for (const library of userLibraries) {
    if (!library.mediaServer?.machineId) continue;
    const server = library.mediaServer;
    if (!server) continue;
    const client = new PlexClient(server.url, server.accessToken, {
      skipTlsVerify: server.tlsSkipVerify,
    });

    const collections = await client.getCollections(library.key);
    const collection = collections.find((c) => c.title === oldName);
    if (!collection) continue;

    await client.renameCollection(
      library.key,
      collection.ratingKey,
      newName
    );
    logger.info(
      "Lifecycle",
      `Renamed Plex collection "${oldName}" → "${newName}" in library "${library.title}"`
    );
  }
}
