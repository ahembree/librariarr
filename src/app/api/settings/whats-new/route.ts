import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, whatsNewSeenSchema } from "@/lib/validation";
import { fetchChangelog } from "@/lib/version/update-checker";
import { compareSemver } from "@/lib/version/semver";
import { notesSinceVersion } from "@/lib/version/release-notes";
import { installedVersion, whatsNewDue } from "@/lib/version/whats-new";

/**
 * The release notes the "What's new" dialog shows after an upgrade: every
 * release since the version whose dialog was last closed, up to the running
 * one. `show` is false when nothing is owed, or when GitHub has no notes to
 * give yet (the dialog then waits for a later load rather than being marked
 * seen with nothing in it).
 */
export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const currentVersion = installedVersion();
  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
    select: { lastSeenVersion: true },
  });
  const lastSeenVersion = settings?.lastSeenVersion ?? null;

  if (!currentVersion || !whatsNewDue(lastSeenVersion, currentVersion)) {
    return NextResponse.json({ show: false, currentVersion, notes: [] });
  }

  const notes = notesSinceVersion(await fetchChangelog(), lastSeenVersion, currentVersion);
  return NextResponse.json({ show: notes.length > 0, currentVersion, notes });
}

/**
 * Closing the dialog: remember the version it showed, so it stays closed until
 * the next upgrade. The client sends the version it was shown rather than the
 * server taking its own, so an upgrade landing while the dialog was open still
 * gets its own dialog.
 */
export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
    select: { lastSeenVersion: true },
  });
  const stored = settings?.lastSeenVersion ?? null;
  // Never step back: a second tab closing an older dialog must not make the
  // newer one show again.
  if (stored !== null && compareSemver(version, stored) <= 0) {
    return NextResponse.json({ lastSeenVersion: stored });
  }

  await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    create: { userId: session.userId!, lastSeenVersion: version },
    update: { lastSeenVersion: version },
    select: { id: true },
  });

  return NextResponse.json({ lastSeenVersion: version });
}
