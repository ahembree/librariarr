import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Delete (revoke) an API key. The `/api/v1` guard looks keys up on every
 * request and caches nothing, so the key stops working on its very next
 * request — there is no grace period to wait out.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const apiKey = await prisma.apiKey.findFirst({
    where: { id, userId: session.userId! },
    select: { id: true, name: true, prefix: true },
  });
  if (!apiKey) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }

  // deleteMany, not delete: a concurrent delete of the same key must answer
  // 404 below rather than throw P2025 into a 500.
  const deleted = await prisma.apiKey.deleteMany({
    where: { id: apiKey.id, userId: session.userId! },
  });
  if (deleted.count === 0) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }

  logger.info("Auth", `API key "${apiKey.name}" (${apiKey.prefix}…) deleted — access revoked`);

  return NextResponse.json({ success: true });
}
