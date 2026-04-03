import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { fetchChangelog } from "@/lib/version/update-checker";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const notes = await fetchChangelog();

  return NextResponse.json({ notes });
}
