import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { listBackups } from "@/lib/backup/backup-service";

export async function GET() {
  // Only allowed when no users exist (initial setup)
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    return NextResponse.json({ error: "Setup already completed" }, { status: 403 });
  }

  const backups = await listBackups();
  return NextResponse.json({ backups });
}
