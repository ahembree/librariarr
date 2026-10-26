import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { readSessionsSnapshot } from "./snapshot";

/**
 * Every enabled server's playback sessions, and the servers that could not be
 * reached. Read through the poll the Stream Manager's event stream shares
 * (`readSessionsSnapshot`), so a refresh here — the sidebar's stream badge on
 * every session change — does not ask every server again when a poll that
 * began after the last pushed change is a few seconds old.
 */
export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessions, unreachableServers } = await readSessionsSnapshot(session.userId!);
  return NextResponse.json({ sessions, unreachableServers });
}
