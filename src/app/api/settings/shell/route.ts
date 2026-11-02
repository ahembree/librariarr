import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { loadShellSettings } from "@/lib/settings/shell-settings";

/**
 * The display settings the authenticated layout renders, for an open tab to
 * re-read when `display-settings:changed` says one was saved elsewhere. The
 * same read as the layout's, so the two cannot disagree.
 */
export const GET = withSession(async (session) => {
  const settings = await loadShellSettings(session.userId);
  if (!settings) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(settings, { headers: { "Cache-Control": "no-store" } });
});
