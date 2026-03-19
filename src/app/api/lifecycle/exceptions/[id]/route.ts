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

  const exception = await prisma.lifecycleException.findFirst({
    where: { id, userId: session.userId! },
  });

  if (!exception) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.lifecycleException.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
