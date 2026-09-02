import { NextResponse } from "next/server";
import { withApiKey } from "@/lib/api/v1";
import { prisma } from "@/lib/db";

/**
 * A safe subset of the system information the settings page shows.
 *
 * The internal `/api/system/info` also reports the database size and the latest
 * applied migration, both gathered by raw SQL introspection. Those are omitted
 * here on purpose: an external integration has no use for them, and every
 * infrastructural detail on this response is extra value in a stolen key —
 * schema version and storage footprint are exactly the reconnaissance an
 * attacker wants before deciding what to try next. Version, counts and uptime
 * are what a dashboard or a health check actually needs.
 *
 * Counts are scoped through the owning user even though this is a single-admin
 * app: the scoping is what makes the query correct rather than incidentally
 * right, and it costs nothing.
 */
export const GET = withApiKey(async (_request, { userId }) => {
  const [mediaItems, servers, enabledLibraries] = await Promise.all([
    prisma.mediaItem.count({ where: { library: { mediaServer: { userId } } } }),
    prisma.mediaServer.count({ where: { userId } }),
    prisma.library.count({ where: { enabled: true, mediaServer: { userId } } }),
  ]);

  return NextResponse.json({
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown",
    // Seconds since this process started. Whole seconds — sub-second precision
    // would only ever be noise in a status readout.
    uptimeSeconds: Math.floor(process.uptime()),
    stats: { mediaItems, servers, enabledLibraries },
  });
});
