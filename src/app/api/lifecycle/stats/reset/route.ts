import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function POST() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();

  await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    create: {
      userId: session.userId!,
      deletionStatsResetAt: now,
    },
    update: { deletionStatsResetAt: now },
  });

  return NextResponse.json({ resetAt: now.toISOString() });
}
