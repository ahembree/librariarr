import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, dashboardLayoutSchema } from "@/lib/validation";
import { isValidLayout } from "@/lib/dashboard/card-registry";
import type { DashboardLayout } from "@/lib/dashboard/card-registry";
import { announceDisplaySettingsChanged, staleRevisionBody } from "@/lib/settings/display-settings-events";
import { Prisma } from "@/generated/prisma/client";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const select = { dashboardLayout: true, dashboardLayoutRevision: true } as const;
  const settings =
    (await prisma.appSettings.findUnique({ where: { userId: session.userId! }, select })) ??
    (await prisma.appSettings.create({ data: { userId: session.userId! }, select }));

  return NextResponse.json({
    layout: settings.dashboardLayout as DashboardLayout | null,
    revision: settings.dashboardLayoutRevision,
  });
}

/**
 * Saves the layout. A body carrying `revision` is saved only while the stored
 * revision still equals it, so a tab or device whose layout is out of date gets
 * a 409 instead of overwriting the newer one — the save replaces the whole
 * layout. Without `revision` the save is unconditional.
 */
export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, dashboardLayoutSchema);
  if (error) return error;

  const { layout, revision } = data;

  if (!isValidLayout(layout)) {
    return NextResponse.json(
      { error: "Invalid dashboard layout" },
      { status: 400 }
    );
  }

  const userId = session.userId!;
  const jsonLayout = layout as unknown as Prisma.InputJsonValue;
  const stored = await prisma.appSettings.findUnique({
    where: { userId },
    select: { dashboardLayoutRevision: true },
  });

  let newRevision: number;
  if (!stored) {
    if (revision !== undefined && revision !== 0) {
      return NextResponse.json(staleRevisionBody("dashboard layout", 0), { status: 409 });
    }
    try {
      await prisma.appSettings.create({
        data: { userId, dashboardLayout: jsonLayout, dashboardLayoutRevision: 1 },
        select: { id: true },
      });
    } catch (e) {
      // Another request created the row first: this save was based on nothing.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return conflict(userId);
      }
      throw e;
    }
    newRevision = 1;
  } else {
    const base = stored.dashboardLayoutRevision;
    if (revision !== undefined && revision !== base) return conflict(userId);
    // Conditional on the revision read above: a save that landed in between
    // moves it, and this one then matches nothing.
    const { count } = await prisma.appSettings.updateMany({
      where: { userId, dashboardLayoutRevision: base },
      data: { dashboardLayout: jsonLayout, dashboardLayoutRevision: { increment: 1 } },
    });
    if (count === 0) return conflict(userId);
    newRevision = base + 1;
  }

  announceDisplaySettingsChanged(userId);
  return NextResponse.json({ layout, revision: newRevision });
}

async function conflict(userId: string) {
  const current = await prisma.appSettings.findUnique({
    where: { userId },
    select: { dashboardLayoutRevision: true },
  });
  return NextResponse.json(
    staleRevisionBody("dashboard layout", current?.dashboardLayoutRevision ?? 0),
    { status: 409 },
  );
}
