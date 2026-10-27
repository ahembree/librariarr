import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { getImageCacheStats, clearImageCache } from "@/lib/image-cache/image-cache";

export const GET = withSession(async () => {
  const stats = await getImageCacheStats();
  return NextResponse.json(stats);
});

export const DELETE = withSession(async () => {
  try {
    await clearImageCache();
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to clear image cache" },
      { status: 500 },
    );
  }
});
