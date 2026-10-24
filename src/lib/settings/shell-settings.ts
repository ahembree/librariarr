import { cache } from "react";
import { getSession } from "@/lib/auth/session";
import { authMethodLabel } from "@/lib/auth/auth-method";
import { prisma } from "@/lib/db";
import { ACCENT_NAMES } from "@/lib/theme/accent-colors";
import { installedVersion, whatsNewDue } from "@/lib/version/whats-new";
import { loadLibraryTypes } from "@/lib/media/library-types";
import type { DashboardLayout } from "@/lib/dashboard/card-registry";
import type { ChipColorMap } from "@/lib/theme/chip-colors";
import type { ColumnPreferences, ShellSettings } from "@/lib/settings/shell-settings-types";

/**
 * The request's session, read once per server render. The root layout (for
 * the accent) and the authenticated layout (for the guard) each validated it
 * on their own, a session check and a user query apiece.
 */
export const getRequestSession = cache(getSession);

/**
 * Every display setting the authenticated shell renders, and the library types
 * and maintenance state the shell itself shows, in one read, shared
 * by the root and authenticated layouts within a request. Selects only these
 * fields: the row also holds credentials. Null when the user does not exist.
 */
export const loadShellSettings = cache(async (userId: string): Promise<ShellSettings | null> => {
  const [user, libraryTypes] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        username: true,
        plexId: true,
        ssoEnabled: true,
        ssoProvider: true,
        appSettings: {
          select: {
            accentColor: true,
            chipColors: true,
            columnPreferences: true,
            cardDisplayPreferences: true,
            dashboardLayout: true,
            dashboardLayoutRevision: true,
            columnPreferencesRevision: true,
            lastSeenVersion: true,
            maintenanceMode: true,
          },
        },
      },
    }),
    loadLibraryTypes(userId),
  ]);
  if (!user) return null;

  const settings = user.appSettings;
  return {
    // A preset that has since been removed reads as the default, as the
    // accent route answers it.
    accentColor:
      settings && ACCENT_NAMES.includes(settings.accentColor) ? settings.accentColor : "default",
    user: { username: user.username, authMethod: authMethodLabel(user) },
    chipColors: (settings?.chipColors ?? null) as Partial<ChipColorMap> | null,
    columnPreferences: (settings?.columnPreferences ?? null) as ColumnPreferences | null,
    columnPreferencesRevision: settings?.columnPreferencesRevision ?? 0,
    cardDisplayPreferences: (settings?.cardDisplayPreferences ?? null) as Record<string, unknown> | null,
    dashboardLayout: (settings?.dashboardLayout ?? null) as DashboardLayout | null,
    dashboardLayoutRevision: settings?.dashboardLayoutRevision ?? 0,
    whatsNewDue: whatsNewDue(settings?.lastSeenVersion ?? null, installedVersion()),
    libraryTypes,
    maintenanceActive: settings?.maintenanceMode ?? false,
  };
});
