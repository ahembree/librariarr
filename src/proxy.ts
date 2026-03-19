import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getExternalBaseUrl } from "@/lib/url";

export function proxy(request: NextRequest) {
  const sessionCookie = request.cookies.get("librariarr_session");
  const isAuthPage =
    request.nextUrl.pathname.startsWith("/login") ||
    request.nextUrl.pathname.startsWith("/onboarding");
  const isApiRoute = request.nextUrl.pathname.startsWith("/api");

  // Skip proxy for API routes (they handle auth themselves)
  if (isApiRoute) {
    return NextResponse.next();
  }

  // If no session cookie and not on auth page, redirect to login
  if (!sessionCookie && !isAuthPage) {
    return NextResponse.redirect(new URL("/login", getExternalBaseUrl(request)));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
