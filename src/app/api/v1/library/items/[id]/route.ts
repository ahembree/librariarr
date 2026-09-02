import { NextResponse } from "next/server";
import { withApiKey, v1Error } from "@/lib/api/v1";
import { prisma } from "@/lib/db";
import { sanitize } from "@/lib/api/sanitize";

/**
 * A single media item with its streams and external ids.
 *
 * The lookup is `findFirst` through the library → server → user relation rather
 * than `findUnique` on the id: an id is guessable, and a bare unique lookup
 * would hand back any row whose id a caller happened to name.
 */
export const GET = withApiKey(async (_request, { userId, params }) => {
  const item = await prisma.mediaItem.findFirst({
    where: { id: params.id, library: { mediaServer: { userId } } },
    // `omit` rather than `select` so a column added to MediaItem later shows up
    // here automatically — this is the "everything about one item" endpoint and
    // an allow-list would silently go stale. `filePath` is the absolute path of
    // the file on the media-server host: useful to the app, but infrastructure
    // detail an external integration has no use for and a stolen key should not
    // be able to map out.
    omit: { filePath: true },
    include: {
      streams: { orderBy: [{ streamType: "asc" }, { index: "asc" }, { id: "asc" }] },
      externalIds: { select: { source: true, externalId: true } },
      library: {
        select: {
          id: true,
          title: true,
          type: true,
          mediaServer: { select: { id: true, name: true, type: true } },
        },
      },
    },
  });

  if (!item) return v1Error("Media item not found", 404);

  const { library, ...rest } = item;

  return NextResponse.json({
    item: sanitize({
      ...rest,
      fileSize: item.fileSize?.toString() ?? null,
      library: { id: library.id, title: library.title, type: library.type },
      server: library.mediaServer,
    }),
  });
});
