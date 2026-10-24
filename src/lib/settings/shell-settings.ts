import { cache } from "react";
import { getSession } from "@/lib/auth/session";
import { authMethodLabel } from "@/lib/auth/auth-method";
import { prisma } from "@/lib/db";
import { installedVersion, whatsNewDue } from "@/lib/version/whats-new";
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
 * Every display setting the authenticated shell renders, in one read, shared
 * by the root and authenticated layouts within a request. Selects only these
 * fields: the row also holds credentials. Null when the user does not exist.
 */
export const loadShellSettings = cache(async (userId: string): Promise<ShellSettings | null> => {
  const user = await prisma.user.findUnique({
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
          lastSeenVersion: true,
        },
      },
    },
  });
  if (!user) return null;

  const settings = user.appSettings;
  return {
    accentColor: settings?.accentColor ?? "default",
    user: { username: user.username, authMethod: authMethodLabel(user) },
    chipColors: (settings?.chipColors ?? null) as Partial<ChipColorMap> | null,
    columnPreferences: (settings?.columnPreferences ?? null) as ColumnPreferences | null,
    cardDisplayPreferences: (settings?.cardDisplayPreferences ?? null) as Record<string, unknown> | null,
    dashboardLayout: (settings?.dashboardLayout ?? null) as DashboardLayout | null,
    whatsNewDue: whatsNewDue(settings?.lastSeenVersion ?? null, installedVersion()),
  };
});
