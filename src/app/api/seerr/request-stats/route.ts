import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getSeerrRequestStats } from "@/lib/seerr/request-stats";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const stats = await getSeerrRequestStats(session.userId!);
  return NextResponse.json(stats);
}
