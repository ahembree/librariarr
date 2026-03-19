import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const item = await prisma.mediaItem.findUnique({
    where: { id },
    include: {
      library: {
        include: { mediaServer: true },
      },
    },
  });

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!item.library.mediaServer) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  if (item.library.mediaServer.userId !== session.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const server = item.library.mediaServer;
    const client = createMediaServerClient(server.type, server.url, server.accessToken, {
      skipTlsVerify: server.tlsSkipVerify,
    });

    // Fetch the episode metadata to get grandparentRatingKey (the show's key)
    const episodeMetadata = await client.getItemMetadata(item.ratingKey);
    const showRatingKey = episodeMetadata.grandparentRatingKey;

    if (!showRatingKey) {
      // Fall back to episode-level data if no grandparent
      return NextResponse.json({
        summary: item.summary,
        genres: item.genres ?? [],
        studio: item.studio,
        contentRating: item.contentRating,
        year: item.year,
      });
    }

    // Fetch the show-level metadata
    const showMetadata = await client.getItemMetadata(showRatingKey);

    return NextResponse.json({
      summary: showMetadata.summary ?? null,
      genres: showMetadata.Genre?.map((g) => g.tag) ?? [],
      studio: showMetadata.studio ?? null,
      contentRating: showMetadata.contentRating ?? null,
      year: showMetadata.year ?? null,
    });
  } catch {
    // Fall back to episode-level data on error
    return NextResponse.json({
      summary: item.summary,
      genres: item.genres ?? [],
      studio: item.studio,
      contentRating: item.contentRating,
      year: item.year,
    });
  }
}
