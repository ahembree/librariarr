import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { apiLogger } from "@/lib/logger";
import { validateRequest, arrActionSchema } from "@/lib/validation";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { data, error } = await validateRequest(request, arrActionSchema);
  if (error) return error;

  const { action, instanceId, arrItemId, type } = data;

  // Verify media item ownership
  const item = await prisma.mediaItem.findUnique({
    where: { id },
    include: {
      library: {
        include: { mediaServer: true },
      },
    },
  });

  if (!item || !item.library.mediaServer || item.library.mediaServer.userId !== session.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    if (type === "radarr") {
      const instance = await prisma.radarrInstance.findFirst({
        where: { id: instanceId, userId: session.userId! },
      });
      if (!instance) {
        return NextResponse.json(
          { error: "Radarr instance not found" },
          { status: 404 }
        );
      }

      const client = new RadarrClient(instance.url, instance.apiKey);

      if (action === "search") {
        await client.triggerMovieSearch(arrItemId);
        return NextResponse.json({ success: true, searchTriggered: true });
      }

      if (action === "checkQueue") {
        const queue = await client.getQueue(arrItemId);
        return NextResponse.json({ success: true, ...queue });
      }
    } else if (type === "lidarr") {
      const instance = await prisma.lidarrInstance.findFirst({
        where: { id: instanceId, userId: session.userId! },
      });
      if (!instance) {
        return NextResponse.json(
          { error: "Lidarr instance not found" },
          { status: 404 }
        );
      }

      const client = new LidarrClient(instance.url, instance.apiKey);

      if (action === "search") {
        await client.triggerArtistSearch(arrItemId);
        return NextResponse.json({ success: true, searchTriggered: true });
      }

      if (action === "checkQueue") {
        const queue = await client.getQueue(arrItemId);
        return NextResponse.json({ success: true, ...queue });
      }
    } else if (type === "sonarr") {
      const instance = await prisma.sonarrInstance.findFirst({
        where: { id: instanceId, userId: session.userId! },
      });
      if (!instance) {
        return NextResponse.json(
          { error: "Sonarr instance not found" },
          { status: 404 }
        );
      }

      const client = new SonarrClient(instance.url, instance.apiKey);

      if (action === "search") {
        await client.triggerSeriesSearch(arrItemId);
        return NextResponse.json({ success: true, searchTriggered: true });
      }

      if (action === "checkQueue") {
        const queue = await client.getQueue(arrItemId);
        return NextResponse.json({ success: true, ...queue });
      }
    }

    return NextResponse.json(
      { error: "Invalid action or type" },
      { status: 400 }
    );
  } catch (error) {
    apiLogger.error("Media", "Arr action failed", { error: String(error) });
    return NextResponse.json(
      { error: sanitizeErrorDetail(error instanceof Error ? error.message : "Action failed") },
      { status: 500 }
    );
  }
}
