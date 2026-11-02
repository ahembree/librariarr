import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { getSeerrRequestStats } from "@/lib/seerr/request-stats";

export const GET = withSession(async (session) => {
  const stats = await getSeerrRequestStats(session.userId);
  return NextResponse.json(stats);
});
