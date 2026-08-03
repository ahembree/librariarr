import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { fetchChangelog } from "@/lib/version/update-checker";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { notes, ok, stale, error, fetchedAt } = await fetchChangelog();

  // Always 200: the changelog is informational, and the client distinguishes
  // "GitHub unreachable" from "no releases published" via `ok`/`error`.
  return NextResponse.json({ notes, ok, stale, error, fetchedAt });
}
