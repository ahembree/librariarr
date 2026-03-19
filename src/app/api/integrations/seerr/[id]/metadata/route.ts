import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { SeerrClient } from "@/lib/seerr/seerr-client";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const instance = await prisma.seerrInstance.findFirst({
    where: { id, userId: session.userId },
  });

  if (!instance) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  const client = new SeerrClient(instance.url, instance.apiKey);

  // Fetch all users with pagination
  const users: string[] = [];
  let skip = 0;
  const take = 100;
  let hasMore = true;

  while (hasMore) {
    const response = await client.getUsers({ take, skip });
    for (const user of response.results) {
      const name = user.plexUsername || user.username || user.email;
      if (name) users.push(name);
    }
    skip += take;
    hasMore = response.results.length === take;
  }

  return NextResponse.json({
    users: [...new Set(users)].sort((a, b) => a.localeCompare(b)),
  });
}
