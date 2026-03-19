import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const userCount = await prisma.user.count();
  let localAuthEnabled = false;

  if (userCount > 0) {
    const settings = await prisma.appSettings.findFirst({
      select: { localAuthEnabled: true },
    });
    localAuthEnabled = settings?.localAuthEnabled ?? false;
  }

  return NextResponse.json({
    setupRequired: userCount === 0,
    localAuthEnabled,
  });
}
