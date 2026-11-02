import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { validateRequest, columnPreferencesSchema } from "@/lib/validation";
import { announceDisplaySettingsChanged, staleRevisionBody } from "@/lib/settings/display-settings-events";

export const GET = withSession(async (session) => {
  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId },
    select: { columnPreferences: true, columnPreferencesRevision: true },
  });

  return NextResponse.json({
    preferences: settings?.columnPreferences ?? null,
    revision: settings?.columnPreferencesRevision ?? 0,
  });
});

// A save without a revision retries this many times when another save lands
// between its read and its write; one with a revision answers 409 instead.
const UNCONDITIONAL_ATTEMPTS = 3;

/**
 * Saves one library type's visible columns, keeping the other types'. A body
 * carrying `revision` is saved only while the stored revision still equals it
 * (409 otherwise), so a stale tab or device cannot overwrite a newer list.
 */
export const PUT = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, columnPreferencesSchema);
  if (error) return error;

  const { type, columns, revision } = data;
  const userId = session.userId;

  for (let attempt = 0; attempt < UNCONDITIONAL_ATTEMPTS; attempt++) {
    const settings = await prisma.appSettings.findUnique({
      where: { userId },
      select: { columnPreferences: true, columnPreferencesRevision: true },
    });
    const base = settings?.columnPreferencesRevision ?? 0;
    if (revision !== undefined && revision !== base) {
      return NextResponse.json(staleRevisionBody("column selection", base), { status: 409 });
    }

    const existing = (settings?.columnPreferences ?? {}) as Record<string, string[]>;
    const json = JSON.parse(JSON.stringify({ ...existing, [type]: columns }));

    if (!settings) {
      const created = await prisma.appSettings.createMany({
        data: [{ userId, columnPreferences: json, columnPreferencesRevision: 1 }],
        skipDuplicates: true,
      });
      if (created.count === 1) return saved(userId, 1);
    } else {
      // Conditional on the revision read above, so a save landing in between
      // is never overwritten with this request's stale copy of the other types.
      const { count } = await prisma.appSettings.updateMany({
        where: { userId, columnPreferencesRevision: base },
        data: { columnPreferences: json, columnPreferencesRevision: { increment: 1 } },
      });
      if (count === 1) return saved(userId, base + 1);
    }
    if (revision !== undefined) break;
  }

  const current = await prisma.appSettings.findUnique({
    where: { userId },
    select: { columnPreferencesRevision: true },
  });
  return NextResponse.json(
    staleRevisionBody("column selection", current?.columnPreferencesRevision ?? 0),
    { status: 409 },
  );
});

function saved(userId: string, revision: number) {
  announceDisplaySettingsChanged(userId);
  return NextResponse.json({ success: true, revision });
}
