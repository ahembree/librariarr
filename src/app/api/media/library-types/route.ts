import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { loadLibraryTypes } from "@/lib/media/library-types";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(await loadLibraryTypes(session.userId!));
}
