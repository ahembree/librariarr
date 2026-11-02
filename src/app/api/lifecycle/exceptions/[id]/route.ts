import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";

export const DELETE = withSession(async (
  session,
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  // deleteMany, not findFirst + delete: a concurrent removal of the same
  // exception (a second tab, or two API calls) must answer 404 here rather
  // than throw P2025 into a 500.
  const { count } = await prisma.lifecycleException.deleteMany({
    where: { id, userId: session.userId },
  });

  if (count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
});
