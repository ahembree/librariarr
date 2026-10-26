import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { computeDeletionStats } from "@/lib/lifecycle/deletion-stats";

export const GET = withSession(async (session) => {
  return NextResponse.json(await computeDeletionStats(session.userId));
});
