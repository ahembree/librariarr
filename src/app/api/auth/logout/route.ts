import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { getExternalBaseUrl, isSameOriginRequest } from "@/lib/url";

/**
 * Logging out has to REVOKE, not merely forget. The session is a stateless
 * encrypted cookie: clearing it from this browser leaves any copy of it —
 * a stolen cookie, another device — valid until the seal expires. Bumping
 * the user's `sessionVersion` is what makes `getSession` refuse every
 * outstanding cookie. This is a single-admin app, so "log out" meaning "log
 * out everywhere" is the behaviour a user pressing the button expects.
 * Best-effort: a DB hiccup must not stop the local cookie being cleared.
 */
async function revokeAllSessions(userId: string | undefined) {
  if (!userId) return;
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
    });
  } catch {
    // The cookie is still destroyed below; revocation elsewhere is best-effort.
  }
}

export async function POST(request: NextRequest) {
  // Same-origin check on POST too, for consistency with GET. SameSite=Lax
  // already blocks the cookie on cross-site POSTs, but some browsers (legacy
  // versions, niche configurations) have inconsistent enforcement. Cheap
  // defense-in-depth.
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const session = await getSession();
  await revokeAllSessions(session.userId);
  session.destroy();
  return NextResponse.json({ success: true });
}

export async function GET(request: NextRequest) {
  // Block cross-site logout CSRF (e.g. `<img src="/api/auth/logout">` from an
  // attacker page would otherwise log the victim out). The authenticated
  // layout's server-side redirect to this endpoint when the session is
  // invalid sends no Origin/Referer, which passes the same-origin check.
  if (!isSameOriginRequest(request)) {
    return NextResponse.redirect(new URL("/login", getExternalBaseUrl(request)));
  }
  const session = await getSession();
  await revokeAllSessions(session.userId);
  session.destroy();
  return NextResponse.redirect(new URL("/login", getExternalBaseUrl(request)));
}
