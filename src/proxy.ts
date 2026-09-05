import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getExternalBaseUrl, isTrustedMutationOrigin } from "@/lib/url";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function proxy(request: NextRequest) {
  const sessionCookie = request.cookies.get("librariarr_session");
  const isAuthPage =
    request.nextUrl.pathname.startsWith("/login") ||
    request.nextUrl.pathname.startsWith("/onboarding");
  const isApiRoute = request.nextUrl.pathname.startsWith("/api");

  // API routes handle auth themselves. The proxy's one job for them is the
  // CSRF origin check on state-changing methods — applied here, once, rather
  // than remembered in 100+ route files. See `isTrustedMutationOrigin`.
  if (isApiRoute) {
    if (!SAFE_METHODS.has(request.method) && !isTrustedMutationOrigin(request)) {
      return NextResponse.json(
        { error: "Cross-site request rejected" },
        { status: 403 }
      );
    }
    return NextResponse.next();
  }

  // If no session cookie and not on auth page, redirect to login
  if (!sessionCookie && !isAuthPage) {
    return NextResponse.redirect(new URL("/login", getExternalBaseUrl(request)));
  }

  return NextResponse.next();
}

export const config = {
  // Skip static assets and the Next.js app-icon / manifest conventions so
  // browsers (and unauthenticated users) can fetch the favicon, apple-touch
  // icon, and web app manifest without being bounced to /login. File patterns
  // are anchored with $ so paths like /icon.svg/anything are not bypassed.
  matcher: [
    "/((?!_next/static/|_next/image$|favicon\\.ico$|icon\\.svg$|icon\\.png$|icon-[^/]+\\.(?:png|svg)$|apple-icon(?:-[^/]+)?\\.png$|manifest\\.(?:webmanifest|json)$|robots\\.txt$|sitemap\\.xml$).*)",
  ],
};
