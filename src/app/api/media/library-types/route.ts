import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { loadLibraryTypes } from "@/lib/media/library-types";

export const GET = withSession(async (session) => {
  return NextResponse.json(await loadLibraryTypes(session.userId));
});
