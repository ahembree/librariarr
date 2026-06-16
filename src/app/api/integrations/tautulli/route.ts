import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { TautulliClient } from "@/lib/tautulli/client";
import { validateRequest, tautulliInstanceCreateSchema } from "@/lib/validation";
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const instances = await prisma.tautulliInstance.findMany({
    where: { userId: session.userId! },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ instances: sanitize(instances) });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, tautulliInstanceCreateSchema);
  if (error) return error;
  const { name, url, apiKey, mediaServerId } = data;

  // If linking to a Plex server, verify ownership.
  if (mediaServerId) {
    const server = await prisma.mediaServer.findFirst({
      where: { id: mediaServerId, userId: session.userId! },
    });
    if (!server) {
      return NextResponse.json({ error: "Media server not found" }, { status: 404 });
    }
  }

  const client = new TautulliClient(url, apiKey);
  const result = await client.testConnection();
  if (!result.ok) {
    return NextResponse.json(
      { error: "Failed to connect to Tautulli", detail: sanitizeErrorDetail(result.error) },
      { status: 400 }
    );
  }

  const instance = await prisma.tautulliInstance.create({
    data: {
      userId: session.userId!,
      name,
      url: url.replace(/\/+$/, ""),
      apiKey,
      mediaServerId: mediaServerId ?? null,
    },
  });

  return NextResponse.json({ instance: sanitize(instance) }, { status: 201 });
}
