import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, dashboardLayoutSchema } from "@/lib/validation";
import { isValidLayout } from "@/lib/dashboard/card-registry";
import type { DashboardLayout } from "@/lib/dashboard/card-registry";
import type { Prisma } from "@/generated/prisma/client";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { userId: session.userId! },
    });
  }

  return NextResponse.json({
    layout: settings.dashboardLayout as DashboardLayout | null,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, dashboardLayoutSchema);
  if (error) return error;

  const { layout } = data;

  if (!isValidLayout(layout)) {
    return NextResponse.json(
      { error: "Invalid dashboard layout" },
      { status: 400 }
    );
  }

  const jsonLayout = layout as unknown as Prisma.InputJsonValue;
  const settings = await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    update: { dashboardLayout: jsonLayout },
    create: { userId: session.userId!, dashboardLayout: jsonLayout },
  });

  return NextResponse.json({
    layout: settings.dashboardLayout as DashboardLayout | null,
  });
}
