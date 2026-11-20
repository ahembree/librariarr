import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { getExternalBaseUrl, isSameOriginRequest } from "@/lib/url";
import { apiLogger } from "@/lib/logger";
import { auditMeta } from "@/lib/auth/audit";

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
  if (session.userId) apiLogger.info("Auth", "Signed out — every session revoked", auditMeta(request));
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
  // A top-level navigation from another site carries no Origin, and a link
  // with rel=noreferrer no Referer either, so the lenient check above lets it
  // through — and it would sign the admin out on every device. The browser
  // labels such a navigation `Sec-Fetch-Site: cross-site` (or `same-site` from
  // a sibling subdomain), which page script cannot change; it signs nobody
  // out. The layout's own redirect is same-origin, and an address-bar visit is
  // `none`, so both still log out.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site" || fetchSite === "same-site") {
    return NextResponse.redirect(new URL("/login", getExternalBaseUrl(request)));
  }
  const session = await getSession();
  // Browsers send `Sec-Fetch-Site` only to a trustworthy origin (https, or
  // localhost). On a plain-http install it is absent, so a page anywhere that
  // navigates here with `Referrer-Policy: no-referrer` arrives with no
  // Origin, no Referer and no label — exactly like the layout's own redirect —
  // and the SameSite=Lax cookie rides the top-level GET: it signed the admin
  // out on every device, as often as the page cared to.
  //
  // So a session that is still VALID is signed out by this GET only when the
  // request shows where it came from: a matching Origin or Referer (checked
  // above when present), or the browser's own `same-origin` / `none`. The one
  // caller that sends none of them is the layout, and it redirects here only
  // for a session `getSession()` has already refused — which the branch below
  // still clears. The Sign Out button is a POST.
  const showsItsOrigin =
    request.headers.has("origin") ||
    request.headers.has("referer") ||
    fetchSite === "same-origin" ||
    fetchSite === "none";
  if (session.isLoggedIn && !showsItsOrigin) {
    return NextResponse.redirect(new URL("/", getExternalBaseUrl(request)));
  }
  await revokeAllSessions(session.userId);
  if (session.userId) apiLogger.info("Auth", "Signed out — every session revoked", auditMeta(request));
  session.destroy();
  return NextResponse.redirect(new URL("/login", getExternalBaseUrl(request)));
}
