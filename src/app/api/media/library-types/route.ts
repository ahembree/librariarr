import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const servers = await prisma.mediaServer.findMany({
    where: { userId: session.userId, enabled: true },
    select: { id: true },
  });
  const serverIds = servers.map((s) => s.id);

  if (serverIds.length === 0) {
    return NextResponse.json({ types: [], allTypes: [] });
  }

  const [enabledLibraries, allLibraries] = await Promise.all([
    prisma.library.findMany({
      where: {
        mediaServerId: { in: serverIds },
        enabled: true,
      },
      select: { type: true },
      distinct: ["type"],
    }),
    prisma.library.findMany({
      where: {
        mediaServerId: { in: serverIds },
      },
      select: { type: true },
      distinct: ["type"],
    }),
  ]);

  return NextResponse.json({
    types: enabledLibraries.map((l) => l.type),
    allTypes: allLibraries.map((l) => l.type),
  });
}
