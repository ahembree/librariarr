import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { validateRequest, serverTestSchema } from "@/lib/validation";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

export const POST = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, serverTestSchema);
  if (error) return error;

  const { url, accessToken, type, tlsSkipVerify } = data;

  const client = createMediaServerClient(
    type,
    url,
    accessToken,
    { skipTlsVerify: !!tlsSkipVerify }
  );

  const result = await client.testConnection();

  return NextResponse.json({ ok: result.ok, error: sanitizeErrorDetail(result.error) ?? null, serverName: result.serverName ?? null });
});
