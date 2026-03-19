import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { createMediaServerClient } from "@/lib/media-server/factory";
import type { MediaServerType } from "@/generated/prisma/client";
import { validateRequest, serverTestSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, serverTestSchema);
  if (error) return error;

  const { url, accessToken, type, tlsSkipVerify } = data;

  const client = createMediaServerClient(
    type as MediaServerType,
    url,
    accessToken,
    { skipTlsVerify: !!tlsSkipVerify }
  );

  const result = await client.testConnection();

  return NextResponse.json({ ok: result.ok, error: result.error ?? null, serverName: result.serverName ?? null });
}
