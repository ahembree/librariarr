import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, chipColorsSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { chipColors: true },
  });

  return NextResponse.json({
    chipColors: settings?.chipColors ?? null,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, chipColorsSchema);
  if (error) return error;

  const { chipColors } = data;

  await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: { chipColors },
    create: {
      userId: session.userId!,
      chipColors,
    },
  });

  return NextResponse.json({ success: true });
}
