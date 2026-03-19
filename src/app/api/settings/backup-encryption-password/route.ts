import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, backupEncryptionPasswordSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
    select: { backupEncryptionPassword: true },
  });

  return NextResponse.json({
    hasPassword: !!settings?.backupEncryptionPassword,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, backupEncryptionPasswordSchema);
  if (error) return error;

  await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    update: { backupEncryptionPassword: data.backupEncryptionPassword },
    create: { userId: session.userId!, backupEncryptionPassword: data.backupEncryptionPassword },
  });

  return NextResponse.json({
    hasPassword: !!data.backupEncryptionPassword,
  });
}
