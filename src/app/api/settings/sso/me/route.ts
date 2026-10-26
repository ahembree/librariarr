import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";

/** Returns the current user's SSO link state (subject, provider, enabled flag). */
export const GET = withSession(async (session) => {
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { ssoSubject: true, ssoProvider: true, ssoEnabled: true },
  });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(user);
});
