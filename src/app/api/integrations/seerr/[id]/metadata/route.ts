import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import { logger } from "@/lib/logger";

// Hard ceiling on Seerr pagination so a huge or misbehaving instance can't
// hang the request indefinitely. 100 pages × 100 per page = 10k users.
const MAX_PAGES = 100;

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
  let pages = 0;

  try {
    while (hasMore) {
      if (pages >= MAX_PAGES) {
        logger.warn("Seerr", `Users pagination hit MAX_PAGES (${MAX_PAGES}) for ${instance.name} — truncating`);
        break;
      }
      const response = await client.getUsers({ take, skip });
      for (const user of response.results) {
        const name = user.plexUsername || user.username || user.email;
        if (name) users.push(name);
      }
      skip += take;
      pages += 1;
      hasMore = response.results.length === take;
    }
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : "Failed to query Seerr";
    const msg = sanitizeErrorDetail(raw) ?? "Failed to query Seerr";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  return NextResponse.json({
    users: [...new Set(users)].sort((a, b) => a.localeCompare(b)),
  });
}
