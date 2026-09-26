import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withApiKey } from "@/lib/api-keys/guard";
import { getApiKeyPrincipal } from "@/lib/api-keys/principal";

// The calling key itself: name, scopes and expiry, so an integration can check
// what it may do (and when it stops working) before it tries. Any valid key.
export const GET = withApiKey(null, async () => {
  const principal = getApiKeyPrincipal();
  const apiKey = principal
    ? await prisma.apiKey.findUnique({
        where: { id: principal.keyId },
        select: {
          id: true,
          name: true,
          prefix: true,
          scopes: true,
          expiresAt: true,
          createdAt: true,
          lastUsedAt: true,
        },
      })
    : null;
  if (!apiKey) {
    // Deleted between authentication and this read.
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  }
  return NextResponse.json({ apiKey });
});
