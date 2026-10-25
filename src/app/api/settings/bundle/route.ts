import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { withSharedSession } from "@/lib/auth/shared-session";
import { prisma } from "@/lib/db";
import { jsonResponse } from "@/lib/api/json-response";
import { apiLogger } from "@/lib/logger";
import {
  SETTINGS_BUNDLE_PATHS,
  type BundledResponse,
  type SettingsBundlePath,
} from "@/lib/settings/settings-bundle-paths";
import { GET as getServers } from "@/app/api/servers/route";
import { GET as getSyncSchedule } from "@/app/api/settings/sync-schedule/route";
import { GET as getDedup } from "@/app/api/settings/dedup/route";
import { GET as getRealtime } from "@/app/api/settings/realtime/route";
import { GET as getRealtimeStatus } from "@/app/api/tools/realtime/status/route";
import { GET as getSonarr } from "@/app/api/integrations/sonarr/route";
import { GET as getRadarr } from "@/app/api/integrations/radarr/route";
import { GET as getLidarr } from "@/app/api/integrations/lidarr/route";
import { GET as getSeerr } from "@/app/api/integrations/seerr/route";
import { GET as getTracearr } from "@/app/api/integrations/tracearr/route";
import { GET as getAccentColor } from "@/app/api/settings/accent-color/route";
import { GET as getChipColors } from "@/app/api/settings/chip-colors/route";
import { GET as getLogRetention } from "@/app/api/settings/log-retention/route";
import { GET as getDeleteCeiling } from "@/app/api/settings/delete-ceiling/route";
import { GET as getActionRetention } from "@/app/api/settings/action-retention/route";
import { GET as getBackupSchedule } from "@/app/api/settings/backup-schedule/route";
import { GET as getBackups } from "@/app/api/backup/route";
import { GET as getBackupEncryptionPassword } from "@/app/api/settings/backup-encryption-password/route";
import { GET as getLifecycleSchedule } from "@/app/api/settings/lifecycle-schedule/route";
import { GET as getScheduleInfo } from "@/app/api/settings/schedule-info/route";
import { GET as getDiscord } from "@/app/api/settings/discord/route";
import { GET as getAi } from "@/app/api/settings/ai/route";
import { GET as getAuth } from "@/app/api/settings/auth/route";
import { GET as getTitlePreference } from "@/app/api/settings/title-preference/route";

const HANDLERS: Record<SettingsBundlePath, () => Promise<Response>> = {
  "/api/servers": getServers,
  "/api/settings/sync-schedule": getSyncSchedule,
  "/api/settings/dedup": getDedup,
  "/api/settings/realtime": getRealtime,
  "/api/tools/realtime/status": getRealtimeStatus,
  "/api/integrations/sonarr": getSonarr,
  "/api/integrations/radarr": getRadarr,
  "/api/integrations/lidarr": getLidarr,
  "/api/integrations/seerr": getSeerr,
  "/api/integrations/tracearr": getTracearr,
  "/api/settings/accent-color": getAccentColor,
  "/api/settings/chip-colors": getChipColors,
  "/api/settings/log-retention": getLogRetention,
  "/api/settings/delete-ceiling": getDeleteCeiling,
  "/api/settings/action-retention": getActionRetention,
  "/api/settings/backup-schedule": getBackupSchedule,
  "/api/backup": getBackups,
  "/api/settings/backup-encryption-password": getBackupEncryptionPassword,
  "/api/settings/lifecycle-schedule": getLifecycleSchedule,
  "/api/settings/schedule-info": getScheduleInfo,
  "/api/settings/discord": getDiscord,
  "/api/settings/ai": getAi,
  "/api/settings/auth": getAuth,
  "/api/settings/title-preference": getTitlePreference,
};

const KNOWN = new Set<string>(SETTINGS_BUNDLE_PATHS);

/**
 * The Settings page's opening reads in one request: `paths` names routes from
 * `SETTINGS_BUNDLE_PATHS`, each answered by its own GET handler — the same
 * status and body a request to it gets — under one session check
 * (`withSharedSession`). One handler failing does not fail the others.
 */
export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("paths");
  const paths = [...new Set((raw ?? "").split(",").filter(Boolean))];
  const unknown = paths.filter((path) => !KNOWN.has(path));
  if (paths.length === 0 || unknown.length > 0) {
    return NextResponse.json(
      { error: unknown.length > 0 ? `Not a bundled route: ${unknown.join(", ")}` : "No paths requested" },
      { status: 400 },
    );
  }

  return withSharedSession(async () => {
    const session = await getSession();
    if (!session.isLoggedIn || !session.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Several of these handlers create the settings row when it is missing.
    // Run side by side on a first visit they would race to insert it, so it
    // is created once first.
    await prisma.appSettings.upsert({
      where: { userId: session.userId },
      update: {},
      create: { userId: session.userId },
      select: { id: true },
    });

    const answers = await Promise.all(
      paths.map(async (path): Promise<[string, BundledResponse]> => {
        try {
          const res = await HANDLERS[path as SettingsBundlePath]();
          const body = await res.json().catch(() => null);
          return [path, { status: res.status, body }];
        } catch (error) {
          apiLogger.error("Settings", `Bundled read of ${path} failed`, {
            error: error instanceof Error ? error.message : String(error),
          });
          return [path, { status: 500, body: { error: "Internal server error" } }];
        }
      }),
    );

    return jsonResponse(
      request,
      { parts: Object.fromEntries(answers) },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}
