"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Clock, Loader2, Play, RefreshCw, Workflow } from "lucide-react";
import type { CronScheduleSetting } from "@/hooks/use-cron-schedule-setting";
import { formatDateTime } from "@/lib/format";
import { SettingsSection } from "../components";
import { SCHEDULE_OPTIONS } from "../types";
import type { ScheduleInfo } from "../types";

type JobKey = "sync" | "detection" | "execution";

/** A run's next time: its date, or how a schedule the dispatcher has not picked up reads. */
function formatNextRun(nextRun: string | null, lastRun: string | null): string {
  if (!nextRun) return "Manual only";
  const d = new Date(nextRun);
  const diffMs = d.getTime() - Date.now();
  if (diffMs > 0) return d.toLocaleString();
  // Never run before — waiting for first scheduler tick
  if (!lastRun) return "Pending";
  // Past date — scheduler hasn't picked it up yet
  const overdueMs = Math.abs(diffMs);
  if (overdueMs <= 15 * 60 * 1000) return "Due now";
  const mins = Math.round(overdueMs / 60000);
  if (mins < 60) return `Overdue (${mins}m ago)`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Overdue (${hrs}h ago)`;
  return `Overdue (${Math.round(hrs / 24)}d ago)`;
}

interface SchedulingTabProps {
  // Daily run time
  scheduledJobTime: string;
  savingJobTime: boolean;
  onScheduledJobTimeChange: (value: string) => void;

  // The three schedules (`useCronScheduleSetting`) and when each last ran
  syncSchedule: CronScheduleSetting;
  lastScheduledSync: string | null;
  detectionSchedule: CronScheduleSetting;
  lastLcDetect: string | null;
  executionSchedule: CronScheduleSetting;
  lastLcExec: string | null;

  // Timezone
  timezone: string | null;

  // Schedule info & run now
  scheduleInfo: ScheduleInfo | null;
  runningJob: JobKey | null;
  onRunNow: (job: JobKey) => void;
}

interface ScheduleRowProps {
  jobKey: JobKey;
  selectId: string;
  label: string;
  description?: string;
  setting: CronScheduleSetting;
  lastRun: string | null;
  nextRun: string | null;
  runningJob: JobKey | null;
  onRunNow: (job: JobKey) => void;
}

function ScheduleRow({
  jobKey,
  selectId,
  label,
  description,
  setting,
  lastRun,
  nextRun,
  runningJob,
  onRunNow,
}: ScheduleRowProps) {
  const { schedule, isCustom, customCron, error: cronError, saving } = setting;
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex-1 min-w-0">
        <Label htmlFor={selectId}>{label}</Label>
        {description && (
          <p className="text-xs text-muted-foreground mb-1.5">{description}</p>
        )}
        <Select value={schedule} onValueChange={setting.onScheduleChange}>
          <SelectTrigger id={selectId} className="mt-1.5 w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isCustom && (
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <Input
                placeholder="0 */4 * * *"
                value={customCron}
                onChange={(e) => setting.setCustomCron(e.target.value)}
                className="w-48 font-mono"
              />
              <Button
                size="sm"
                onClick={() => void setting.save(customCron)}
                disabled={!customCron || saving}
              >
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save
              </Button>
            </div>
            {cronError && (
              <p className="mt-1 text-sm text-destructive">{cronError}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Standard 5-field cron expression (min hour dom mon dow).
            </p>
          </div>
        )}
      </div>
      <div className="text-sm text-muted-foreground space-y-1 sm:text-right shrink-0">
        {saving ? (
          <Loader2 className="h-4 w-4 animate-spin sm:ml-auto" />
        ) : (
          <>
            <div>Last run: {formatDateTime(lastRun, "Never")}</div>
            <div>Next run: {formatNextRun(nextRun, lastRun)}</div>
            <Button
              variant="outline"
              size="sm"
              className="mt-1"
              onClick={() => onRunNow(jobKey)}
              disabled={!!runningJob}
            >
              {runningJob === jobKey ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Play className="h-3 w-3 mr-1" />
              )}
              Run Now
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function SchedulingTab({
  scheduledJobTime,
  savingJobTime,
  onScheduledJobTimeChange,
  syncSchedule,
  lastScheduledSync,
  detectionSchedule,
  lastLcDetect,
  executionSchedule,
  lastLcExec,
  timezone,
  scheduleInfo,
  runningJob,
  onRunNow,
}: SchedulingTabProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">Scheduling</h2>
        <p className="text-sm text-muted-foreground">
          Configure when Librariarr runs library syncs and lifecycle rules.
        </p>
      </div>

      {/* Daily Run Time */}
      <SettingsSection
        icon={Clock}
        title="Daily Run Time"
        description="Preset schedules (Daily, Weekly, Every 6h, Every 12h) run at this time, with sub-daily schedules using it as their starting anchor. Custom cron expressions ignore this setting and run at whatever times their expression specifies. All schedules use the server's local timezone."
      >
          <div>
            <Label htmlFor="scheduled-job-time">Time of day for scheduled jobs</Label>
            <div className="mt-1.5 flex items-center gap-2">
              <Input
                id="scheduled-job-time"
                type="time"
                value={scheduledJobTime}
                onChange={(e) => onScheduledJobTimeChange(e.target.value)}
                className="w-36"
                disabled={savingJobTime}
              />
              {savingJobTime && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
            {timezone && (
              <p className="mt-2 text-xs text-muted-foreground">
                Server timezone: <span className="font-medium text-foreground/70">{timezone}</span>
                <span className="mx-1.5 text-muted-foreground/50">·</span>
                <a
                  href="https://librariarr.dev/docs/getting-started/configuration/#timezone"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  How to change this
                </a>
              </p>
            )}
          </div>
      </SettingsSection>

      {/* Library Sync */}
      <SettingsSection
        icon={RefreshCw}
        title="Library Sync"
        description="How often Librariarr fetches metadata from your connected media servers."
      >
          <ScheduleRow
            jobKey="sync"
            selectId="sync-schedule"
            label="Automatic sync frequency"
            setting={syncSchedule}
            lastRun={lastScheduledSync}
            nextRun={scheduleInfo?.sync.nextRun ?? null}
            runningJob={runningJob}
            onRunNow={onRunNow}
          />
      </SettingsSection>

      {/* Lifecycle Rules */}
      <SettingsSection
        icon={Workflow}
        title="Lifecycle Rules"
        description="Detection scans for media matching rules; execution applies the scheduled actions."
        contentClassName="space-y-6"
      >
          <div>
            <h4 className="text-sm font-medium mb-3">Detection</h4>
            <ScheduleRow
              jobKey="detection"
              selectId="lc-detect-schedule"
              label="Rule detection frequency"
              description="How often to scan for media matching lifecycle rules."
              setting={detectionSchedule}
              lastRun={lastLcDetect}
              nextRun={scheduleInfo?.detection.nextRun ?? null}
              runningJob={runningJob}
              onRunNow={onRunNow}
            />
          </div>

          <Separator />

          <div>
            <h4 className="text-sm font-medium mb-3">Execution</h4>
            <ScheduleRow
              jobKey="execution"
              selectId="lc-exec-schedule"
              label="Action execution frequency"
              description="How often to execute scheduled lifecycle actions."
              setting={executionSchedule}
              lastRun={lastLcExec}
              nextRun={scheduleInfo?.execution.nextRun ?? null}
              runningJob={runningJob}
              onRunNow={onRunNow}
            />
          </div>
      </SettingsSection>
    </div>
  );
}
