/**
 * The one v1 route that is deliberately unauthenticated.
 *
 * Container health checks, load balancers and uptime monitors have to be able
 * to tell whether the instance is alive without holding a credential —
 * requiring an API key here would mean provisioning one into every system that
 * merely watches the app, and a probe that 401s is indistinguishable from a
 * probe that found a dead app. It is safe to leave open because the response
 * says nothing about the library or its owner: only the app version and whether
 * Postgres answers.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// The handler takes no request, so without this Next may treat it as a
// statically evaluable GET and run the database probe at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";
  const timestamp = new Date().toISOString();

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    // Deliberately not logged: the logger persists to the database that just
    // failed, so reporting the outage would fail on the outage it reports.
    return NextResponse.json(
      { status: "degraded", database: "unreachable", version, timestamp },
      { status: 503 },
    );
  }

  return NextResponse.json({ status: "ok", database: "ok", version, timestamp });
}
