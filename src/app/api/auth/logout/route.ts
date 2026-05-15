import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getExternalBaseUrl, isSameOriginRequest } from "@/lib/url";

export async function POST(request: NextRequest) {
  // Same-origin check on POST too, for consistency with GET. SameSite=Lax
  // already blocks the cookie on cross-site POSTs, but some browsers (legacy
  // versions, niche configurations) have inconsistent enforcement. Cheap
  // defense-in-depth.
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const session = await getSession();
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
  session.destroy();
  return NextResponse.redirect(new URL("/login", getExternalBaseUrl(request)));
}
