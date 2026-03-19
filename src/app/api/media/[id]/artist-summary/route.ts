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

    // Fetch the track metadata to get grandparentRatingKey (the artist's key)
    const trackMetadata = await client.getItemMetadata(item.ratingKey);
    const artistRatingKey = trackMetadata.grandparentRatingKey;

    if (!artistRatingKey) {
      // Fall back to track-level data if no grandparent
      return NextResponse.json({
        summary: item.summary,
        genres: item.genres ?? [],
        studio: item.studio,
        contentRating: item.contentRating,
        year: item.year,
      });
    }

    // Fetch the artist-level metadata
    const artistMetadata = await client.getItemMetadata(artistRatingKey);

    return NextResponse.json({
      summary: artistMetadata.summary ?? null,
      genres: artistMetadata.Genre?.map((g) => g.tag) ?? [],
      studio: artistMetadata.studio ?? null,
      contentRating: artistMetadata.contentRating ?? null,
      year: artistMetadata.year ?? null,
    });
  } catch {
    // Fall back to track-level data on error
    return NextResponse.json({
      summary: item.summary,
      genres: item.genres ?? [],
      studio: item.studio,
      contentRating: item.contentRating,
      year: item.year,
    });
  }
}
