import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

export const POST = withSession(async (
  session,
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  const server = await prisma.mediaServer.findFirst({
    where: { id, userId: session.userId },
  });

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const client = createMediaServerClient(server.type, server.url, server.accessToken, {
    skipTlsVerify: server.tlsSkipVerify,
  });

  const result = await client.testConnection();

  return NextResponse.json({
    ok: result.ok,
    error: sanitizeErrorDetail(result.error) ?? null,
    serverName: result.serverName ?? null,
  });
});
