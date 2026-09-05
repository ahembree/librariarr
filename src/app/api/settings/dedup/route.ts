import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { eventBus } from "@/lib/events/event-bus";
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

  // Stats are cached per dedup-mode; drop them so the dashboard reflects the
  // toggle immediately instead of after the TTL.
  invalidateMediaCaches();

  // The toggle changes which copy every listing renders, not just the cached
  // stats — so tell open pages to refetch rather than leaving them on the
  // pre-toggle view until the next navigation.
  eventBus.emit({
    type: "sync:completed",
    userId: session.userId!,
    meta: { dedupStats },
  });

  return NextResponse.json({ dedupStats });
}
