import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const instance = await prisma.radarrInstance.findFirst({
    where: { id, userId: session.userId },
  });

  if (!instance) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  try {
    const client = new RadarrClient(instance.url, instance.apiKey);
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
    const raw = error instanceof Error ? error.message : "Failed to query Radarr";
    const msg = sanitizeErrorDetail(raw) ?? "Failed to query Radarr";
    return NextResponse.json({ enabled: null, error: msg, arrUrl: instance.url });
  }
}
