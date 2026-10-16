import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, scheduledJobTimeSchema } from "@/lib/validation";

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, scheduledJobTimeSchema);
  if (error) return error;

  const settings = await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    update: { scheduledJobTime: data.scheduledJobTime },
    create: { userId: session.userId!, scheduledJobTime: data.scheduledJobTime },
    select: { scheduledJobTime: true },
  });

  return NextResponse.json(settings);
}
