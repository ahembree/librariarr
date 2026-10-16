import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // deleteMany, not findFirst + delete: a concurrent removal of the same
  // exception (a second tab, or two API calls) must answer 404 here rather
  // than throw P2025 into a 500.
  const { count } = await prisma.lifecycleException.deleteMany({
    where: { id, userId: session.userId! },
  });

  if (count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
