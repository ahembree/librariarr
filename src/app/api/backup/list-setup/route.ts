import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { listBackups } from "@/lib/backup/backup-service";
import { checkAuthRateLimit, SETUP_BUCKET } from "@/lib/rate-limit/rate-limiter";

export async function GET(request: NextRequest) {
  // Open to anyone until the first admin exists: bounded like the setup
  // route itself (see `SETUP_BUCKET`).
  const rateLimited = checkAuthRateLimit(request, SETUP_BUCKET);
  if (rateLimited) return rateLimited;

  // Only allowed when no users exist (initial setup)
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    return NextResponse.json({ error: "Setup already completed" }, { status: 403 });
  }

  const backups = await listBackups();
  return NextResponse.json({ backups });
}
