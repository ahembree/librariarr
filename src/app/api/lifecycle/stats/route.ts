import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { computeDeletionStats } from "@/lib/lifecycle/deletion-stats";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(await computeDeletionStats(session.userId!));
}
