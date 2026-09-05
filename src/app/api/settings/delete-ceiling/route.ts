import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, deleteCeilingSchema } from "@/lib/validation";

/**
 * The optional ceiling on how many items one destructive lifecycle run may act
 * on. `null` means unlimited, which is the default and the historical
 * behaviour — see `src/lib/lifecycle/delete-ceiling.ts` for why this is opt-in
 * rather than a shipped cap.
 */
export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
    select: { maxAutoDeleteItems: true },
  });

  return NextResponse.json({ maxAutoDeleteItems: settings?.maxAutoDeleteItems ?? null });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, deleteCeilingSchema);
  if (error) return error;

  // `null` is the meaningful "no ceiling" value, so the field is written
  // whenever it was sent — a truthy check would make clearing it impossible.
  const { maxAutoDeleteItems } = data;

  await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    create: { userId: session.userId!, maxAutoDeleteItems },
    update: { maxAutoDeleteItems },
  });

  return NextResponse.json({ maxAutoDeleteItems });
}
