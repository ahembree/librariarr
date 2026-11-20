import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { validateRequest, backupEncryptionPasswordSchema } from "@/lib/validation";
import { hasRecentLogin } from "@/lib/auth/recent-login";
import { reauthRequired } from "@/lib/auth/reauth";
import { logSecurityChange } from "@/lib/auth/audit";

export const GET = withSession(async (session) => {
  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { backupEncryptionPassword: true },
  });

  return NextResponse.json({
    hasPassword: !!settings?.backupEncryptionPassword,
  });
});

export const PUT = withSession(async (session, request: NextRequest) => {
  // Creating, downloading and restoring a backup need a recent sign-in
  // because the file holds the Plex token and the caller may choose the
  // passphrase (recent-login.ts). This route IS choosing the passphrase, for
  // every scheduled backup from now on: left open, a stale cookie could clear
  // it — the next scheduled backup is then written in plaintext — or set one
  // of its own, which decrypts any copy it later obtains and locks the admin
  // out of restoring.
  if (!hasRecentLogin(session)) {
    return reauthRequired(session.userId, "Changing the backup encryption password");
  }

  const { data, error } = await validateRequest(request, backupEncryptionPasswordSchema);
  if (error) return error;

  await prisma.appSettings.upsert({
    where: { userId: session.userId },
    update: { backupEncryptionPassword: data.backupEncryptionPassword },
    create: { userId: session.userId, backupEncryptionPassword: data.backupEncryptionPassword },
  });

  logSecurityChange(
    request,
    data.backupEncryptionPassword
      ? "Backup encryption password set"
      : "Backup encryption password removed — scheduled backups are no longer encrypted",
  );

  return NextResponse.json({
    hasPassword: !!data.backupEncryptionPassword,
  });
});
