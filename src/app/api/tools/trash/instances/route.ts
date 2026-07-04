import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listGuideInstances } from "@/lib/trash/status";

// Every Sonarr + Radarr instance, tagged with its service type, for the TRaSH
// sync instance picker. Credentials are never included in the response.
export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const instances = await listGuideInstances(session.userId!);
  return NextResponse.json({ instances });
}
