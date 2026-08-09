import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { isHardwareTranscode } from "@/lib/media-server/hardware-transcode";
import { logger } from "@/lib/logger";
import type { MediaSession } from "@/lib/media-server/types";

let initialized = false;
let isRunning = false;
let prerollRunning = false;

// Tracks when a session was first seen for pending termination.
// Keys are namespaced per subsystem so the maintenance/transcode loop and the
// blackout warn_then_terminate loop can't read each other's pending entries
// (which would apply the wrong delay):
//   maintenance/transcode → "maint:userId:serverId:sessionId"
//   blackout              → "blackout:scheduleId:userId:serverId:sessionId"
const pendingTerminations = new Map<string, number>();

// For "block_new_only" blackout: tracks session IDs that existed when the
// blackout started. Keyed PER SERVER (`${userId}-${scheduleId}:${serverId}`)
// because session IDs are only meaningful to the server that issued them —
// a schedule-level key let whichever server answered first write the snapshot,
// after which every other server's pre-existing sessions looked "new" and were
// terminated on the very first tick.
const knownBlackoutSessions = new Map<string, Set<string>>();

/** Snapshot key for one server under one blackout schedule. */
function blackoutSnapshotKey(blackoutKey: string, serverId: string): string {
  return `${blackoutKey}:${serverId}`;
}

/** Drops every per-server snapshot belonging to a blackout schedule. */
function clearBlackoutSnapshots(blackoutKey: string) {
  const prefix = `${blackoutKey}:`;
  for (const key of knownBlackoutSessions.keys()) {
    if (key.startsWith(prefix)) knownBlackoutSessions.delete(key);
  }
}

interface TranscodeManagerCriteria {
  anyTranscoding: boolean;
  videoTranscoding: boolean;
  audioTranscoding: boolean;
  fourKTranscoding: boolean;
  remoteTranscoding: boolean;
}

/** Exported for direct unit testing. */
export function sessionMatchesCriteria(
  session: MediaSession,
  criteria: TranscodeManagerCriteria
): boolean {
  const t = session.transcoding;
  const isVideoTranscode = !!(t && t.videoDecision === "transcode");
  const isAudioTranscode = !!(t && t.audioDecision === "transcode");
  const isAnyTranscode = isVideoTranscode || isAudioTranscode;
  // Source resolution of the file being played — both Plex's session `Media`
  // element and Jellyfin/Emby's `NowPlayingItem` streams describe the original
  // file, never the transcode target.
  const is4K = (session.mediaWidth ?? 0) >= 3840 || (session.mediaHeight ?? 0) >= 2160;
  const isRemote = !session.player.local;

  if (criteria.anyTranscoding && isAnyTranscode) return true;
  if (criteria.videoTranscoding && isVideoTranscode) return true;
  if (criteria.audioTranscoding && isAudioTranscode) return true;
  // "4K Transcoding" targets the expensive case: 4K *video* being re-encoded.
  // A 4K file whose audio alone is transcoded direct-streams the video and
  // costs the server almost nothing, so it must not match here — it used to,
  // which silently killed cheap streams. Users who do want those caught pick
  // "Audio Transcoding" or "Any Transcoding".
  if (criteria.fourKTranscoding && isVideoTranscode && is4K) return true;
  if (criteria.remoteTranscoding && isAnyTranscode && isRemote) return true;

  return false;
}

/** Exported for direct unit testing. */
export function isBlackoutActive(schedule: {
  scheduleType: string;
  startDate: Date | null;
  endDate: Date | null;
  daysOfWeek: unknown;
  startTime: string | null;
  endTime: string | null;
}): boolean {
  const now = new Date();

  if (schedule.scheduleType === "one_time") {
    if (!schedule.startDate || !schedule.endDate) return false;
    return now >= schedule.startDate && now <= schedule.endDate;
  }

  if (schedule.scheduleType === "recurring") {
    const days = schedule.daysOfWeek as number[] | null;
    if (!days || !schedule.startTime || !schedule.endTime) return false;

    const [startH, startM] = schedule.startTime.split(":").map(Number);
    const [endH, endM] = schedule.endTime.split(":").map(Number);
    const currentMin = now.getHours() * 60 + now.getMinutes();
    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;

    const today = now.getDay();

    // Overnight spans (e.g. 22:00 to 06:00) run past midnight into the NEXT
    // calendar day, so the selected day identifies when the window *starts*.
    // Testing the day against `now` alone both truncated the window at
    // midnight and made it spuriously active in the small hours of the
    // start day itself.
    if (endMin <= startMin) {
      const yesterday = (today + 6) % 7;
      return (
        (days.includes(today) && currentMin >= startMin) ||
        (days.includes(yesterday) && currentMin <= endMin)
      );
    }

    return days.includes(today) && currentMin >= startMin && currentMin <= endMin;
  }

  return false;
}

// Cache the last-set preroll path per user to avoid redundant Plex API calls
const lastPrerollPath = new Map<string, string>();

function isPrerollScheduleActive(schedule: {
  scheduleType: string;
  startDate: Date | null;
  endDate: Date | null;
  daysOfWeek: unknown;
  startTime: string | null;
  endTime: string | null;
}): boolean {
  // Seasonal = an annually-recurring date range (compare month/day, ignore
  // year). Not a blackout schedule type, so handle it here — otherwise
  // isBlackoutActive falls through to `return false` and seasonal preroll
  // schedules never activate.
  if (schedule.scheduleType === "seasonal") {
    if (!schedule.startDate || !schedule.endDate) return false;
    const now = new Date();
    const md = (d: Date) => (d.getMonth() + 1) * 100 + d.getDate();
    const cur = md(now);
    const start = md(schedule.startDate);
    const end = md(schedule.endDate);
    // Wrap across the year boundary (e.g. Dec 15 → Jan 5).
    if (end < start) return cur >= start || cur <= end;
    return cur >= start && cur <= end;
  }
  // one_time / recurring share the blackout active check (same structure).
  return isBlackoutActive(schedule);
}

async function processPrerollSchedules() {
  // Re-entrancy guard: a slow Plex call must not let one tick overlap the next.
  if (prerollRunning) return;
  prerollRunning = true;
  try {
    const schedules = await prisma.prerollSchedule.findMany({
      where: { enabled: true },
      orderBy: { priority: "desc" },
      include: {
        user: {
          select: {
            id: true,
            mediaServers: {
              where: { type: "PLEX", enabled: true },
              select: { id: true, type: true, url: true, accessToken: true, tlsSkipVerify: true },
            },
          },
        },
      },
    });

    if (schedules.length === 0) return;

    // Group by user
    const byUser = new Map<string, { servers: typeof schedules[0]["user"]["mediaServers"]; schedules: typeof schedules }>();
    for (const schedule of schedules) {
      if (!byUser.has(schedule.userId)) {
        byUser.set(schedule.userId, { servers: schedule.user.mediaServers, schedules: [] });
      }
      byUser.get(schedule.userId)!.schedules.push(schedule);
    }

    // Also handle users who have NO active schedules but previously had preroll set
    // We need to clear for them. Track which users were processed.
    const processedUserIds = new Set<string>();

    for (const [userId, { servers, schedules: userSchedules }] of byUser) {
      processedUserIds.add(userId);

      // Find highest-priority active schedule
      const activeSchedule = userSchedules.find((s) => isPrerollScheduleActive(s));
      const desiredPath = activeSchedule?.prerollPath ?? "";
      const cached = lastPrerollPath.get(userId);

      if (cached === desiredPath) continue; // No change needed

      await Promise.allSettled(
        servers.map(async (server) => {
          try {
            const client = createMediaServerClient(server.type, server.url, server.accessToken, {
              skipTlsVerify: server.tlsSkipVerify,
            });

            if (desiredPath) {
              await client.setPrerollPath?.(desiredPath);
              logger.info("Enforcer", `Preroll: set to "${desiredPath}" for schedule "${activeSchedule!.name}"`);
            } else {
              await client.clearPreroll?.();
              logger.info("Enforcer", "Preroll: cleared (no active schedule)");
            }
          } catch (error) {
            logger.error("Enforcer", "Preroll: could not update server", { error: String(error) });
          }
        }),
      );

      lastPrerollPath.set(userId, desiredPath);
    }

    // Clean up cache for users with no enabled schedules
    for (const userId of lastPrerollPath.keys()) {
      if (!processedUserIds.has(userId)) {
        // User no longer has any enabled schedules — clear preroll if cached
        if (lastPrerollPath.get(userId) !== "") {
          // Need to look up their servers
          const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
              mediaServers: {
                where: { type: "PLEX", enabled: true },
                select: { type: true, url: true, accessToken: true, tlsSkipVerify: true },
              },
            },
          });
          if (user) {
            await Promise.allSettled(
              user.mediaServers.map(async (server) => {
                try {
                  const client = createMediaServerClient(server.type, server.url, server.accessToken, {
                    skipTlsVerify: server.tlsSkipVerify,
                  });
                  await client.clearPreroll?.();
                  logger.info("Enforcer", "Preroll: cleared (no more enabled schedules)");
                } catch (error) {
                  logger.debug("Enforcer", "Preroll: could not clear on server", { error: String(error) });
                }
              }),
            );
          }
          lastPrerollPath.set(userId, "");
        }
      }
    }
  } catch (error) {
    logger.error("Enforcer", "Error processing preroll schedules", { error: String(error) });
  } finally {
    prerollRunning = false;
  }
}

/** Single enforcement tick — exported for direct testing. */
export async function runEnforcerTick() {
  if (isRunning) return;
  isRunning = true;

  try {
      const allSettings = await prisma.appSettings.findMany({
        where: {
          OR: [
            { maintenanceMode: true },
            { transcodeManagerEnabled: true },
          ],
        },
        include: {
          user: {
            include: {
              mediaServers: {
                where: { enabled: true },
                select: { id: true, type: true, name: true, url: true, accessToken: true, tlsSkipVerify: true },
              },
            },
          },
        },
      });

      if (allSettings.length === 0) {
        // No maintenance/transcode rules — drop only this subsystem's pending
        // entries, leaving blackout entries untouched.
        for (const key of pendingTerminations.keys()) {
          if (key.startsWith("maint:")) pendingTerminations.delete(key);
        }
      } else {
        const now = Date.now();
        const activeSessionKeys = new Set<string>();
        // Servers whose session list we actually retrieved this tick. A server
        // that was unreachable contributes no keys, so pruning purely on
        // `activeSessionKeys` would forget its pending entries and restart
        // every grace period from zero on the next successful poll.
        const polledServerIds = new Set<string>();
        const enforcedUserIds = new Set(allSettings.map((s) => s.userId));
        const knownServerIds = new Set(
          allSettings.flatMap((s) => s.user.mediaServers.map((server) => server.id))
        );

        for (const settings of allSettings) {
          const maintenanceEnabled = settings.maintenanceMode;
          const maintenanceDelayMs = (settings.maintenanceDelay ?? 30) * 1000;
          const maintenanceMsg = settings.maintenanceMessage || "Server is in maintenance mode.";

          const transcodeEnabled = settings.transcodeManagerEnabled;
          const transcodeDelayMs = (settings.transcodeManagerDelay ?? 30) * 1000;
          const transcodeMsg = settings.transcodeManagerMessage || "This stream has been terminated.";
          const exemptHardware = settings.transcodeManagerExemptHardware ?? false;
          const criteria = (settings.transcodeManagerCriteria as TranscodeManagerCriteria | null) ?? {
            anyTranscoding: false,
            videoTranscoding: false,
            audioTranscoding: false,
            fourKTranscoding: false,
            remoteTranscoding: false,
          };

          await Promise.allSettled(settings.user.mediaServers.map(async (server) => {
            try {
              const client = createMediaServerClient(server.type, server.url, server.accessToken, {
                skipTlsVerify: server.tlsSkipVerify,
              });
              const sessions = await client.getSessions();
              polledServerIds.add(server.id);

              for (const session of sessions) {
                const sessionKey = `maint:${settings.userId}:${server.id}:${session.sessionId}`;
                activeSessionKeys.add(sessionKey);

                // Determine if this session should be terminated and with what delay/message
                let shouldTerminate = false;
                let delay = 0;
                let message = "";

                if (maintenanceEnabled && !settings.maintenanceExcludedUsers.includes(session.username)) {
                  shouldTerminate = true;
                  delay = maintenanceDelayMs;
                  message = maintenanceMsg;
                }

                // A hardware encode costs the CPU little, so the admin can opt
                // to leave those alone. Note this says nothing about whether
                // the transcode is keeping up — a saturated GPU still reports
                // hardware acceleration while running below realtime.
                const hardwareExempt = exemptHardware && isHardwareTranscode(session);

                if (transcodeEnabled && !hardwareExempt && !settings.transcodeManagerExcludedUsers.includes(session.username) && sessionMatchesCriteria(session, criteria)) {
                  if (!shouldTerminate || transcodeDelayMs < delay) {
                    delay = transcodeDelayMs;
                    message = transcodeMsg;
                  }
                  shouldTerminate = true;
                }

                if (!shouldTerminate) continue;

                // Track first-seen time
                if (!pendingTerminations.has(sessionKey)) {
                  pendingTerminations.set(sessionKey, now);
                  logger.info(
                    "Enforcer",
                    `Session "${session.username}" on "${server.name}" (${session.title}) pending termination (delay: ${delay / 1000}s)`
                  );
                }

                const firstSeen = pendingTerminations.get(sessionKey)!;
                if (now - firstSeen >= delay) {
                  try {
                    await client.terminateSession(session.sessionId, message);
                    logger.info(
                      "Enforcer",
                      `Terminated session for "${session.username}" on "${server.name}" (${session.title})`
                    );
                    pendingTerminations.delete(sessionKey);
                  } catch (error) {
                    logger.error(
                      "Enforcer",
                      `Failed to terminate session ${session.sessionId} on "${server.name}"`,
                      { error: String(error) }
                    );
                  }
                }
              }
            } catch (error) {
              logger.debug(
                "Enforcer",
                `Could not reach server "${server.name}"`,
                { error: String(error) }
              );
            }
          }));
        }

        // Prune maintenance/transcode entries for sessions that no longer
        // exist. Only touch "maint:" keys — blackout entries are pruned in
        // their own loop below.
        for (const key of pendingTerminations.keys()) {
          if (!key.startsWith("maint:")) continue;
          // "maint:<userId>:<serverId>:<sessionId>" — ids never contain ":".
          const [, userId, serverId] = key.split(":");

          // No longer enforced for this user, or the server was removed or
          // disabled: the entry can never be matched again, so drop it.
          if (!enforcedUserIds.has(userId) || !knownServerIds.has(serverId)) {
            pendingTerminations.delete(key);
            continue;
          }

          // Server exists but was unreachable this tick — say nothing about
          // its sessions rather than resetting their grace periods.
          if (!polledServerIds.has(serverId)) continue;

          if (!activeSessionKeys.has(key)) pendingTerminations.delete(key);
        }
      }

      // --- Blackout Schedule Processing ---
      const blackoutSchedules = await prisma.blackoutSchedule.findMany({
        where: { enabled: true },
        include: {
          user: {
            select: {
              mediaServers: { where: { enabled: true }, select: { id: true, type: true, name: true, url: true, accessToken: true, tlsSkipVerify: true } },
            },
          },
        },
      });

      const activeBlackoutKeys = new Set<string>();
      // Pending-termination keys for warn_then_terminate sessions observed this
      // tick, used to prune stale "blackout:" entries below.
      const activeBlackoutSessionKeys = new Set<string>();
      // Schedules currently inside their window, and the "<scheduleId>:<serverId>"
      // pairs we actually reached — same reasoning as polledServerIds above.
      const activeBlackoutScheduleIds = new Set<string>();
      const polledBlackoutServers = new Set<string>();

      for (const schedule of blackoutSchedules) {
        const blackoutKey = `${schedule.userId}-${schedule.id}`;
        activeBlackoutKeys.add(blackoutKey);

        try {
          const active = isBlackoutActive(schedule);

          if (active) {
            activeBlackoutScheduleIds.add(schedule.id);
            const blackoutMsg = schedule.message || "Stream terminated due to scheduled blackout period.";

            await Promise.allSettled(schedule.user.mediaServers.map(async (server) => {
              try {
                const client = createMediaServerClient(server.type, server.url, server.accessToken, {
                  skipTlsVerify: server.tlsSkipVerify,
                });
                const sessions = await client.getSessions();
                polledBlackoutServers.add(`${schedule.id}:${server.id}`);

                const blackoutExcluded = schedule.excludedUsers ?? [];

                if (schedule.action === "terminate_immediate") {
                  for (const session of sessions) {
                    if (blackoutExcluded.includes(session.username)) continue;
                    try {
                      await client.terminateSession(session.sessionId, blackoutMsg);
                      logger.info(
                        "Enforcer",
                        `Blackout "${schedule.name}": terminated session for "${session.username}" (${session.title})`
                      );
                    } catch (error) {
                      logger.error(
                        "Enforcer",
                        `Blackout "${schedule.name}": failed to terminate session ${session.sessionId}`,
                        { error: String(error) }
                      );
                    }
                  }
                } else if (schedule.action === "warn_then_terminate") {
                  const blackoutDelayMs = (schedule.delay ?? 30) * 1000;
                  const blackoutNow = Date.now();

                  for (const session of sessions) {
                    if (blackoutExcluded.includes(session.username)) continue;
                    const sessionKey = `blackout:${schedule.id}:${schedule.userId}:${server.id}:${session.sessionId}`;
                    activeBlackoutSessionKeys.add(sessionKey);

                    if (!pendingTerminations.has(sessionKey)) {
                      pendingTerminations.set(sessionKey, blackoutNow);
                      logger.info(
                        "Enforcer",
                        `Blackout "${schedule.name}": session "${session.username}" (${session.title}) pending termination (delay: ${blackoutDelayMs / 1000}s)`
                      );
                    }

                    const firstSeen = pendingTerminations.get(sessionKey)!;
                    if (blackoutNow - firstSeen >= blackoutDelayMs) {
                      try {
                        await client.terminateSession(session.sessionId, blackoutMsg);
                        logger.info(
                          "Enforcer",
                          `Blackout "${schedule.name}": terminated session for "${session.username}" (${session.title})`
                        );
                        pendingTerminations.delete(sessionKey);
                      } catch (error) {
                        logger.error(
                          "Enforcer",
                          `Blackout "${schedule.name}": failed to terminate session ${session.sessionId}`,
                          { error: String(error) }
                        );
                      }
                    }
                  }
                } else if (schedule.action === "block_new_only") {
                  const snapshotKey = blackoutSnapshotKey(blackoutKey, server.id);
                  if (!knownBlackoutSessions.has(snapshotKey)) {
                    // First time seeing this active blackout on this server —
                    // snapshot its current sessions
                    const currentSessionIds = new Set(sessions.map((s) => s.sessionId));
                    knownBlackoutSessions.set(snapshotKey, currentSessionIds);
                    logger.info(
                      "Enforcer",
                      `Blackout "${schedule.name}": started block_new_only on "${server.name}", snapshotted ${currentSessionIds.size} existing sessions`
                    );
                  } else {
                    // Blackout already active — terminate any sessions not in the known set
                    const knownIds = knownBlackoutSessions.get(snapshotKey)!;
                    for (const session of sessions) {
                      if (blackoutExcluded.includes(session.username)) continue;
                      if (!knownIds.has(session.sessionId)) {
                        try {
                          await client.terminateSession(session.sessionId, blackoutMsg);
                          logger.info(
                            "Enforcer",
                            `Blackout "${schedule.name}": terminated new session for "${session.username}" (${session.title})`
                          );
                        } catch (error) {
                          logger.error(
                            "Enforcer",
                            `Blackout "${schedule.name}": failed to terminate session ${session.sessionId}`,
                            { error: String(error) }
                          );
                        }
                      }
                    }
                  }
                }
              } catch (error) {
                logger.debug(
                  "Enforcer",
                  `Blackout "${schedule.name}": could not reach server`,
                  { error: String(error) }
                );
              }
            }));
          } else {
            // Blackout not active — drop every server's snapshot so the next
            // activation re-grandfathers whatever is playing then.
            clearBlackoutSnapshots(blackoutKey);
          }
        } catch (error) {
          logger.error(
            "Enforcer",
            `Error processing blackout schedule "${schedule.name}"`,
            { error: String(error) }
          );
        }
      }

      // Clean up snapshots for schedules (or servers) that no longer exist.
      // Keys are `${blackoutKey}:${serverId}`, so compare on the prefix.
      for (const key of knownBlackoutSessions.keys()) {
        const blackoutKey = key.slice(0, key.lastIndexOf(":"));
        if (!activeBlackoutKeys.has(blackoutKey)) {
          knownBlackoutSessions.delete(key);
        }
      }

      // Prune warn_then_terminate pending entries for sessions no longer seen
      // under an active blackout (ended session, inactive/deleted schedule).
      for (const key of pendingTerminations.keys()) {
        if (!key.startsWith("blackout:")) continue;
        // "blackout:<scheduleId>:<userId>:<serverId>:<sessionId>".
        const [, scheduleId, , serverId] = key.split(":");

        // Blackout window closed, or the schedule was disabled or deleted.
        if (!activeBlackoutScheduleIds.has(scheduleId)) {
          pendingTerminations.delete(key);
          continue;
        }

        // Server unreachable this tick — keep the entry so the warning period
        // doesn't restart when it comes back.
        if (!polledBlackoutServers.has(`${scheduleId}:${serverId}`)) continue;

        if (!activeBlackoutSessionKeys.has(key)) pendingTerminations.delete(key);
      }

    } catch (error) {
      logger.error("Enforcer", "Error in enforcer", { error: String(error) });
    } finally {
      isRunning = false;
    }
}

let prerollInitialized = false;

export function initializePrerollEnforcer() {
  if (prerollInitialized) return;
  prerollInitialized = true;

  setInterval(processPrerollSchedules, 30000);

  logger.info("Enforcer", "Preroll enforcer initialized — polling every 30 seconds");
}

export function initializeMaintenanceEnforcer() {
  if (initialized) return;
  initialized = true;

  setInterval(runEnforcerTick, 30000);

  logger.info("Enforcer", "Maintenance enforcer initialized — polling every 30 seconds");
}

/** Reset module-level state between tests. */
export function _resetForTesting() {
  initialized = false;
  prerollInitialized = false;
  isRunning = false;
  prerollRunning = false;
  pendingTerminations.clear();
  knownBlackoutSessions.clear();
  lastPrerollPath.clear();
}
