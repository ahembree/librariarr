import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { getImageCacheStats, clearImageCache } from "@/lib/image-cache/image-cache";
import { validateRequest, imageCacheSettingsSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [stats, settings] = await Promise.all([
    getImageCacheStats(),
    prisma.appSettings.findUnique({
      where: { userId: session.userId! },
      select: { prewarmArtwork: true },
    }),
  ]);

  return NextResponse.json({ ...stats, prewarmArtwork: settings?.prewarmArtwork ?? true });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, imageCacheSettingsSchema);
  if (error) return error;
  const { prewarmArtwork } = data;

  await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    update: { prewarmArtwork },
    create: { userId: session.userId!, prewarmArtwork },
  });

  // Takes effect on the next sync — the prewarm job re-reads the flag when it
  // runs, so a run already in flight is not interrupted.
  return NextResponse.json({ prewarmArtwork });
}

export async function DELETE() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await clearImageCache();
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to clear image cache" },
      { status: 500 },
    );
  }
}
