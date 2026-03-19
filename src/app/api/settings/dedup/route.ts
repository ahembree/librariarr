import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, dedupSettingsSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
    select: { dedupStats: true },
  });

  return NextResponse.json({
    dedupStats: settings?.dedupStats ?? true,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, dedupSettingsSchema);
  if (error) return error;
  const { dedupStats } = data;

  await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    update: { dedupStats },
    create: { userId: session.userId!, dedupStats },
  });

  return NextResponse.json({ dedupStats });
}
