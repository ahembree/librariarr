import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getImageCacheStats, clearImageCache } from "@/lib/image-cache/image-cache";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stats = await getImageCacheStats();
  return NextResponse.json(stats);
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
