import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { eventBus } from "@/lib/events/event-bus";
import { validateRequest, realtimeSettingsSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
    select: { realtimeSync: true },
  });

  return NextResponse.json({
    realtimeSync: settings?.realtimeSync ?? true,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, realtimeSettingsSchema);
  if (error) return error;
  const { realtimeSync } = data;

  await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    update: { realtimeSync },
    create: { userId: session.userId!, realtimeSync },
  });

  // Notify the realtime manager to reconcile — turning this off closes every
  // server WebSocket; turning it on re-opens them.
  eventBus.emit({ type: "settings:changed", userId: session.userId!, meta: { realtimeSync } });

  return NextResponse.json({ realtimeSync });
}
