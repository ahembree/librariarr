import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { fetchChangelog } from "@/lib/version/update-checker";

export const GET = withSession(async () => {
  const notes = await fetchChangelog();

  return NextResponse.json({ notes });
});
