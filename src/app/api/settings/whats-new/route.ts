import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { announceDisplaySettingsChanged } from "@/lib/settings/display-settings-events";
import { validateRequest, whatsNewSeenSchema } from "@/lib/validation";
import { fetchReleaseNotes } from "@/lib/version/update-checker";
import { compareSemver } from "@/lib/version/semver";
import { selectWhatsNew } from "@/lib/version/release-notes";
import { installedVersion, whatsNewDue } from "@/lib/version/whats-new";

/**
 * The release notes the "What's new" dialog shows after an upgrade: every
 * release since the version whose dialog was last closed, up to the running
 * one. `show` is false when nothing is owed, or when GitHub has not yet given
 * the running version's own notes (the dialog then waits for a later load
 * rather than being marked seen without them). `truncated` says releases
 * since the last one seen lie past the page GitHub returned.
 */
export const GET = withSession(async (session) => {
  const currentVersion = installedVersion();
  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { lastSeenVersion: true },
  });
  const lastSeenVersion = settings?.lastSeenVersion ?? null;

  if (!currentVersion || !whatsNewDue(lastSeenVersion, currentVersion)) {
    return NextResponse.json({
      show: false,
      currentVersion,
      previousVersion: lastSeenVersion,
      truncated: false,
      notes: [],
    });
  }

  const { notes, hasCurrent, truncated } = selectWhatsNew(
    await fetchReleaseNotes(),
    lastSeenVersion,
    currentVersion,
  );
  return NextResponse.json({
    show: hasCurrent,
    currentVersion,
    previousVersion: lastSeenVersion,
    truncated,
    notes: hasCurrent ? notes : [],
  });
});

/**
 * Closing the dialog: remember the version it showed, so it stays closed until
 * the next upgrade. The client sends the version it was shown rather than the
 * server taking its own, so an upgrade landing while the dialog was open still
 * gets its own dialog.
 */
export const PUT = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, whatsNewSeenSchema);
  if (error) return error;

  const version = data.version.replace(/^v/, "");
  const currentVersion = installedVersion();
  if (currentVersion && compareSemver(version, currentVersion) > 0) {
    return NextResponse.json(
      { error: "That version is newer than the one running" },
      { status: 400 },
    );
  }

  const userId = session.userId;
  // Compare and write under the row's lock: read first and written apart, two
  // tabs closing their dialogs together each passed the check, and the older
  // version could land last and bring the newer dialog back.
  const lastSeenVersion = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ lastSeenVersion: string | null }[]>`
      SELECT "lastSeenVersion" FROM "AppSettings" WHERE "userId" = ${userId} FOR UPDATE`;
    if (rows.length === 0) {
      await tx.appSettings.create({ data: { userId, lastSeenVersion: version }, select: { id: true } });
      return version;
    }
    const stored = rows[0].lastSeenVersion;
    // Never step back: a second tab closing an older dialog must not make the
    // newer one show again.
    if (stored !== null && compareSemver(version, stored) <= 0) return stored;
    await tx.appSettings.update({
      where: { userId },
      data: { lastSeenVersion: version },
      select: { id: true },
    });
    return version;
  });

  announceDisplaySettingsChanged(userId);
  return NextResponse.json({ lastSeenVersion });
});
