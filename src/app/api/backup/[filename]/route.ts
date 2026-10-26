import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { getBackupFilePath, deleteBackup } from "@/lib/backup/backup-service";
import { hasRecentLogin } from "@/lib/auth/recent-login";
import { reauthRequired } from "@/lib/auth/reauth";
import fs from "fs/promises";

export const GET = withSession(async (
  session,
  _request: Request,
  { params }: { params: Promise<{ filename: string }> }
) => {
  // The file carries the Plex token (User.plexToken) and every server's and
  // integration's credentials — plaintext in an unencrypted backup, and behind
  // a passphrase the caller may have chosen in an encrypted one. Whoever holds
  // the Plex token can sign in with it and pass every recent-login check, so a
  // download needs a recent sign-in as creating a backup does: scheduled
  // backups sit in the same directory. Settings renews it in place
  // (`fetchWithReauth`).
  if (!hasRecentLogin(session)) {
    return reauthRequired(session.userId, "Downloading a backup");
  }

  const { filename } = await params;
  const filepath = getBackupFilePath(filename);
  if (!filepath) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  try {
    const data = await fs.readFile(filepath);
    const isGz = filename.endsWith(".gz");
    return new NextResponse(data, {
      headers: {
        "Content-Type": isGz ? "application/gzip" : "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(data.length),
        // Holds the instance's credentials: never kept by a browser or proxy cache.
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Backup not found" }, { status: 404 });
  }
});

export const DELETE = withSession(async (
  session,
  _request: Request,
  { params }: { params: Promise<{ filename: string }> }
) => {
  const { filename } = await params;
  const deleted = await deleteBackup(filename);
  if (!deleted) {
    return NextResponse.json({ error: "Backup not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
});
