import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { checkForUpdate } from "@/lib/version/update-checker";

export const GET = withSession(async () => {
  const result = await checkForUpdate();

  return NextResponse.json({
    updateAvailable: result.updateAvailable,
    latestVersion: result.latestVersion,
    releaseUrl: result.releaseUrl,
  });
});
