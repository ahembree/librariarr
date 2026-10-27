import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { listGuideInstances } from "@/lib/trash/status";

// Every Sonarr + Radarr instance, tagged with its service type, for the TRaSH
// sync instance picker. Credentials are never included in the response.
export const GET = withSession(async (session) => {
  const instances = await listGuideInstances(session.userId);
  return NextResponse.json({ instances });
});
