import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { loadShellSettings } from "@/lib/settings/shell-settings";

/**
 * The display settings the authenticated layout renders, for an open tab to
 * re-read when `display-settings:changed` says one was saved elsewhere. The
 * same read as the layout's, so the two cannot disagree.
 */
export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await loadShellSettings(session.userId);
  if (!settings) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(settings, { headers: { "Cache-Control": "no-store" } });
}
