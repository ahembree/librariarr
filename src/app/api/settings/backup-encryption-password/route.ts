import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { validateRequest, backupEncryptionPasswordSchema } from "@/lib/validation";

export const GET = withSession(async (session) => {
  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { backupEncryptionPassword: true },
  });

  return NextResponse.json({
    hasPassword: !!settings?.backupEncryptionPassword,
  });
});

export const PUT = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, backupEncryptionPasswordSchema);
  if (error) return error;

  await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: { backupEncryptionPassword: data.backupEncryptionPassword },
    create: { userId: session.userId, backupEncryptionPassword: data.backupEncryptionPassword },
  });

  return NextResponse.json({
    hasPassword: !!data.backupEncryptionPassword,
  });
});
