import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { logger } from "@/lib/logger";
import type { MediaSession } from "@/lib/media-server/types";

let initialized = false;
let isRunning = false;

// Tracks when a session was first seen for pending termination
// Key: "userId:serverId:sessionId" → timestamp in ms
const pendingTerminations = new Map<string, number>();

// For "block_new_only" blackout: tracks session IDs that existed when blackout started
// Key: `${userId}-${scheduleId}`, Value: Set of session IDs
const knownBlackoutSessions = new Map<string, Set<string>>();

interface TranscodeManagerCriteria {
  anyTranscoding: boolean;
  videoTranscoding: boolean;
  audioTranscoding: boolean;
  fourKTranscoding: boolean;
  remoteTranscoding: boolean;
}

function sessionMatchesCriteria(
  session: MediaSession,
  criteria: TranscodeManagerCriteria
): boolean {
  const t = session.transcoding;
  const isVideoTranscode = !!(t && t.videoDecision === "transcode");
  const isAudioTranscode = !!(t && t.audioDecision === "transcode");
  const isAnyTranscode = isVideoTranscode || isAudioTranscode;
  const is4K = (session.mediaWidth ?? 0) >= 3840 || (session.mediaHeight ?? 0) >= 2160;
  const isRemote = !session.player.local;

  if (criteria.anyTranscoding && isAnyTranscode) return true;
  if (criteria.videoTranscoding && isVideoTranscode) return true;
  if (criteria.audioTranscoding && isAudioTranscode) return true;
  if (criteria.fourKTranscoding && isAnyTranscode && is4K) return true;
  if (criteria.remoteTranscoding && isAnyTranscode && isRemote) return true;

  return false;
}

function isBlackoutActive(schedule: {
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
    if (!days.includes(now.getDay())) return false;

    const [startH, startM] = schedule.startTime.split(":").map(Number);
    const [endH, endM] = schedule.endTime.split(":").map(Number);
    const currentMin = now.getHours() * 60 + now.getMinutes();
    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;

    // Handle overnight spans (e.g., 22:00 to 06:00)
    if (endMin <= startMin) {
      return currentMin >= startMin || currentMin <= endMin;
    }
    return currentMin >= startMin && currentMin <= endMin;
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
  // Reuse blackout active check — same schedule structure
  return isBlackoutActive(schedule);
}

async function processPrerollSchedules() {
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

      for (const server of servers) {
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
          logger.debug("Enforcer", "Preroll: could not update server", { error: String(error) });
        }
      }

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
            for (const server of user.mediaServers) {
              try {
                const client = createMediaServerClient(server.type, server.url, server.accessToken, {
                  skipTlsVerify: server.tlsSkipVerify,
                });
                await client.clearPreroll?.();
                logger.info("Enforcer", "Preroll: cleared (no more enabled schedules)");
              } catch (error) {
                logger.debug("Enforcer", "Preroll: could not clear on server", { error: String(error) });
              }
            }
          }
          lastPrerollPath.set(userId, "");
        }
      }
    }
  } catch (error) {
    logger.error("Enforcer", "Error processing preroll schedules", { error: String(error) });
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
        pendingTerminations.clear();
        return;
      }

      const now = Date.now();
      const activeSessionKeys = new Set<string>();

      for (const settings of allSettings) {
        const maintenanceEnabled = settings.maintenanceMode;
        const maintenanceDelayMs = (settings.maintenanceDelay ?? 30) * 1000;
        const maintenanceMsg = settings.maintenanceMessage || "Server is in maintenance mode.";

        const transcodeEnabled = settings.transcodeManagerEnabled;
        const transcodeDelayMs = (settings.transcodeManagerDelay ?? 30) * 1000;
        const transcodeMsg = settings.transcodeManagerMessage || "This stream has been terminated.";
        const criteria = (settings.transcodeManagerCriteria as TranscodeManagerCriteria | null) ?? {
          anyTranscoding: false,
          videoTranscoding: false,
          audioTranscoding: false,
          fourKTranscoding: false,
          remoteTranscoding: false,
        };

        for (const server of settings.user.mediaServers) {
          try {
            const client = createMediaServerClient(server.type, server.url, server.accessToken, {
              skipTlsVerify: server.tlsSkipVerify,
            });
            const sessions = await client.getSessions();

            for (const session of sessions) {
              const sessionKey = `${settings.userId}:${server.id}:${session.sessionId}`;
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

              if (transcodeEnabled && !settings.transcodeManagerExcludedUsers.includes(session.username) && sessionMatchesCriteria(session, criteria)) {
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
        }
      }

      // Prune entries for sessions that no longer exist
      for (const key of pendingTerminations.keys()) {
        if (!activeSessionKeys.has(key)) {
          pendingTerminations.delete(key);
        }
      }

      // --- Blackout Schedule Processing ---
      const blackoutSchedules = await prisma.blackoutSchedule.findMany({
        where: { enabled: true },
        include: {
          user: {
            select: {
              mediaServers: { where: { enabled: true }, select: { id: true, type: true, url: true, accessToken: true, tlsSkipVerify: true } },
            },
          },
        },
      });

      const activeBlackoutKeys = new Set<string>();

      for (const schedule of blackoutSchedules) {
        const blackoutKey = `${schedule.userId}-${schedule.id}`;
        activeBlackoutKeys.add(blackoutKey);

        try {
          const active = isBlackoutActive(schedule);

          if (active) {
            const blackoutMsg = schedule.message || "Stream terminated due to scheduled blackout period.";

            for (const server of schedule.user.mediaServers) {
              try {
                const client = createMediaServerClient(server.type, server.url, server.accessToken, {
                  skipTlsVerify: server.tlsSkipVerify,
                });
                const sessions = await client.getSessions();

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
                    const sessionKey = `${schedule.userId}:${server.id}:${session.sessionId}`;

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
                  if (!knownBlackoutSessions.has(blackoutKey)) {
                    // First time seeing this active blackout — snapshot current sessions
                    const currentSessionIds = new Set(sessions.map((s) => s.sessionId));
                    knownBlackoutSessions.set(blackoutKey, currentSessionIds);
                    logger.info(
                      "Enforcer",
                      `Blackout "${schedule.name}": started block_new_only, snapshotted ${currentSessionIds.size} existing sessions`
                    );
                  } else {
                    // Blackout already active — terminate any sessions not in the known set
                    const knownIds = knownBlackoutSessions.get(blackoutKey)!;
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
            }
          } else {
            // Blackout not active — clean up known sessions if entry exists
            if (knownBlackoutSessions.has(blackoutKey)) {
              knownBlackoutSessions.delete(blackoutKey);
            }
          }
        } catch (error) {
          logger.error(
            "Enforcer",
            `Error processing blackout schedule "${schedule.name}"`,
            { error: String(error) }
          );
        }
      }

      // Clean up knownBlackoutSessions entries for schedules that no longer exist
      for (const key of knownBlackoutSessions.keys()) {
        if (!activeBlackoutKeys.has(key)) {
          knownBlackoutSessions.delete(key);
        }
      }

      // --- Preroll Schedule Processing ---
      await processPrerollSchedules();
    } catch (error) {
      logger.error("Enforcer", "Error in enforcer", { error: String(error) });
    } finally {
      isRunning = false;
    }
}

export function initializeMaintenanceEnforcer() {
  if (initialized) return;
  initialized = true;

  setInterval(runEnforcerTick, 30000);

  logger.info("Enforcer", "Initialized — polling every 30 seconds");
}

/** Reset module-level state between tests. */
export function _resetForTesting() {
  initialized = false;
  isRunning = false;
  pendingTerminations.clear();
  knownBlackoutSessions.clear();
  lastPrerollPath.clear();
}
