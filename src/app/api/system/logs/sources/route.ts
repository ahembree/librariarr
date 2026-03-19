import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sources = await prisma.logEntry.findMany({
    distinct: ["source"],
    select: { source: true },
    orderBy: { source: "asc" },
  });

  return NextResponse.json({
    sources: sources.map((s) => s.source),
    categories: ["BACKEND", "API", "DB"],
  });
}
