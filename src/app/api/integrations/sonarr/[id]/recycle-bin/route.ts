import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { SonarrClient } from "@/lib/arr/sonarr-client";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const instance = await prisma.sonarrInstance.findFirst({
    where: { id, userId: session.userId },
  });

  if (!instance) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  try {
    const client = new SonarrClient(instance.url, instance.apiKey);
    const config = await client.getMediaManagementConfig();
    const path = config.recycleBin ?? null;
    const enabled = !!path && path.trim().length > 0;
    return NextResponse.json({
      enabled,
      path,
      cleanupDays: config.recycleBinCleanupDays,
      arrUrl: instance.url,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to query Sonarr";
    return NextResponse.json({ enabled: null, error: msg, arrUrl: instance.url });
  }
}
