import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { checkForUpdate } from "@/lib/version/update-checker";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await checkForUpdate();

  return NextResponse.json({
    updateAvailable: result.updateAvailable,
    latestVersion: result.latestVersion,
  });
}
