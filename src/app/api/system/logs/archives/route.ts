import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listArchives } from "@/lib/logs/archive";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const archives = await listArchives();
  return NextResponse.json({ archives });
}
