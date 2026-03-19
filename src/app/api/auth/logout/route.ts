import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getExternalBaseUrl } from "@/lib/url";

export async function POST() {
  const session = await getSession();
  session.destroy();
  return NextResponse.json({ success: true });
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  session.destroy();
  return NextResponse.redirect(new URL("/login", getExternalBaseUrl(request)));
}
