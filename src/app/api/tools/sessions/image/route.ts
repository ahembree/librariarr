import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const serverId = searchParams.get("serverId");
  const path = searchParams.get("path");

  if (!serverId || !path) {
    return NextResponse.json({ error: "Missing serverId or path" }, { status: 400 });
  }

  // Validate path is a relative path to prevent SSRF
  if (!path.startsWith("/") || path.startsWith("//")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const server = await prisma.mediaServer.findFirst({
    where: { id: serverId, userId: session.userId! },
    select: { url: true, accessToken: true, tlsSkipVerify: true, type: true },
  });

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const client = createMediaServerClient(server.type, server.url, server.accessToken, {
    skipTlsVerify: server.tlsSkipVerify,
  });

  try {
    // Use the client's internal HTTP client (fixed baseURL) to avoid SSRF
    const image = await client.fetchImage(path);
    return new NextResponse(new Uint8Array(image.data), {
      headers: {
        "Content-Type": image.contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to fetch image" }, { status: 502 });
  }
}
