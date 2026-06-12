/** Response shape of GET /api/settings/schedule-info, shared by the
 *  dashboard zones that surface next/last run times. */
export interface ScheduleInfo {
  scheduledJobTime: string;
  timezone: string;
  sync: { nextRun: string | null; lastRun: string | null };
  detection: { nextRun: string | null; lastRun: string | null };
  execution: { nextRun: string | null; lastRun: string | null };
}
