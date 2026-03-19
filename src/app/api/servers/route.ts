import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import type { MediaServerType } from "@/generated/prisma/client";
import { validateRequest, serverAddSchema } from "@/lib/validation";
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const servers = await prisma.mediaServer.findMany({
    where: { userId: session.userId },
    include: {
      libraries: {
        select: { id: true, key: true, title: true, type: true, enabled: true, lastSyncedAt: true, _count: { select: { mediaItems: true } } },
      },
      syncJobs: {
        orderBy: { startedAt: "desc" },
        take: 1,
      },
    },
  });

  return NextResponse.json({ servers: sanitize(servers) });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, serverAddSchema);
  if (error) return error;

  const { name, url, accessToken, machineId, tlsSkipVerify, type } = data;

  if (name) {
    const duplicate = await prisma.mediaServer.findFirst({
      where: { userId: session.userId!, name: { equals: name.trim(), mode: "insensitive" } },
    });
    if (duplicate) {
      return NextResponse.json(
        { error: "A server with this name already exists" },
        { status: 409 }
      );
    }
  }

  // Test connection before saving
  const serverType = (type as MediaServerType) ?? "PLEX";
  const client = createMediaServerClient(serverType, url, accessToken, {
    skipTlsVerify: !!tlsSkipVerify,
  });
  const result = await client.testConnection();
  if (!result.ok) {
    return NextResponse.json(
      {
        error: "Failed to connect to server",
        detail: sanitizeErrorDetail(result.error),
      },
      { status: 400 }
    );
  }

  // Check if a server with the same machineId already exists for this user
  if (machineId) {
    const existing = await prisma.mediaServer.findFirst({
      where: { userId: session.userId!, machineId },
    });
    if (existing) {
      const server = await prisma.mediaServer.update({
        where: { id: existing.id },
        data: { name, url, accessToken, tlsSkipVerify: !!tlsSkipVerify },
      });
      return NextResponse.json({ server: sanitize(server), updated: true }, { status: 200 });
    }
  }

  const server = await prisma.mediaServer.create({
    data: {
      userId: session.userId!,
      type: serverType,
      name: name || "Media Server",
      url,
      accessToken,
      machineId,
      tlsSkipVerify: !!tlsSkipVerify,
    },
  });

  return NextResponse.json({ server: sanitize(server) }, { status: 201 });
}
