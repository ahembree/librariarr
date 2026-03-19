import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { createBackup, getBackupPassphrase, listBackups } from "@/lib/backup/backup-service";
import { validateRequest, backupCreateSchema } from "@/lib/validation";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const backups = await listBackups();
  return NextResponse.json({ backups });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, backupCreateSchema);
  if (error) return error;

  try {
    const passphrase = data.passphrase ?? (await getBackupPassphrase());
    const configOnly = !data.includeMediaData;
    const filename = await createBackup(passphrase, configOnly);
    return NextResponse.json({ success: true, filename });
  } catch (error) {
    return NextResponse.json(
      { error: sanitizeErrorDetail(error instanceof Error ? error.message : "Backup failed") },
      { status: 500 }
    );
  }
}
