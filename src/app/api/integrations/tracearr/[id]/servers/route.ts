import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { TracearrClient } from "@/lib/tracearr/tracearr-client";
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";

/**
 * The media servers this Tracearr instance monitors — the source of the
 * `server_id` UUIDs the per-server mapping dropdown in Settings → Servers binds
 * to `MediaServer.tracearrServerId`.
 *
 * A client failure is answered with a 400 carrying the sanitized message rather
 * than being allowed to throw: this route populates a `<select>`, and an
 * unhandled 500 gives the UI nothing to render but "something went wrong",
 * which is the least useful thing to say about an unreachable Tracearr.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const instance = await prisma.tracearrInstance.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!instance) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const client = new TracearrClient(instance.url, instance.apiKey);
    const servers = await client.listServers();
    // Server descriptors carry no secrets, but everything on the integrations
    // surface goes out through `sanitize()` so nothing depends on knowing that.
    return NextResponse.json({ servers: sanitize(servers) });
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : "Failed to query Tracearr";
    return NextResponse.json(
      { error: "Failed to query Tracearr", detail: sanitizeErrorDetail(raw) },
      { status: 400 }
    );
  }
}
