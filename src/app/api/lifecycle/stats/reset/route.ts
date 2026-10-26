import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";

export const POST = withSession(async (session) => {
  const now = new Date();

  await prisma.appSettings.upsert({
    where: { userId: session.userId },
    create: {
      userId: session.userId,
      deletionStatsResetAt: now,
    },
    update: { deletionStatsResetAt: now },
  });

  return NextResponse.json({ resetAt: now.toISOString() });
});
