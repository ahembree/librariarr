"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { SCHEDULE_OPTIONS } from "../types";
import type { ScheduleInfo } from "../types";

type JobKey = "sync" | "detection" | "execution";

export interface SchedulingTabProps {
  // Daily run time
  scheduledJobTime: string;
  savingJobTime: boolean;
  onScheduledJobTimeChange: (value: string) => void;

  // Sync schedule
  syncSchedule: string;
  isCustomSchedule: boolean;
  customCron: string;
  cronError: string;
  savingSchedule: boolean;
  lastScheduledSync: string | null;
  onSyncScheduleChange: (value: string) => void;
  onCustomCronChange: (value: string) => void;
  onSaveSyncSchedule: (value: string) => void;

  // Lifecycle detection schedule
  lcDetectSchedule: string;
  isCustomLcDetect: boolean;
  customLcDetectCron: string;
  lcDetectCronError: string;
  savingLcDetect: boolean;
  lastLcDetect: string | null;
  onLcDetectScheduleChange: (value: string) => void;
  onCustomLcDetectCronChange: (value: string) => void;
  onSaveLcDetectSchedule: (value: string) => void;

  // Lifecycle execution schedule
  lcExecSchedule: string;
  isCustomLcExec: boolean;
  customLcExecCron: string;
  lcExecCronError: string;
  savingLcExec: boolean;
  lastLcExec: string | null;
  onLcExecScheduleChange: (value: string) => void;
  onCustomLcExecCronChange: (value: string) => void;
  onSaveLcExecSchedule: (value: string) => void;

  // Timezone
  timezone: string | null;

  // Schedule info & run now
  scheduleInfo: ScheduleInfo | null;
  runningJob: JobKey | null;
  onRunNow: (job: JobKey) => void;

  // Helpers
  formatDate: (date: string | null) => string;
  formatNextRun: (nextRun: string | null, lastRun: string | null) => string;
}

interface ScheduleRowProps {
  jobKey: JobKey;
  selectId: string;
  label: string;
  description?: string;
  schedule: string;
  isCustom: boolean;
  customCron: string;
  cronError: string;
  saving: boolean;
  lastRun: string | null;
  nextRun: string | null;
  runningJob: JobKey | null;
  onScheduleChange: (value: string) => void;
  onCustomCronChange: (value: string) => void;
  onSaveCustomCron: (value: string) => void;
  onRunNow: (job: JobKey) => void;
  formatDate: (date: string | null) => string;
  formatNextRun: (nextRun: string | null, lastRun: string | null) => string;
}

function ScheduleRow({
  jobKey,
  selectId,
  label,
  description,
  schedule,
  isCustom,
  customCron,
  cronError,
  saving,
  lastRun,
  nextRun,
  runningJob,
  onScheduleChange,
  onCustomCronChange,
  onSaveCustomCron,
  onRunNow,
  formatDate,
  formatNextRun,
}: ScheduleRowProps) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex-1 min-w-0">
        <Label htmlFor={selectId}>{label}</Label>
        {description && (
          <p className="text-xs text-muted-foreground mb-1.5">{description}</p>
        )}
        <Select value={schedule} onValueChange={onScheduleChange}>
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
                onChange={(e) => onCustomCronChange(e.target.value)}
                className="w-48 font-mono"
              />
              <Button
                size="sm"
                onClick={() => onSaveCustomCron(customCron)}
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
            <div>Last run: {formatDate(lastRun)}</div>
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
  isCustomSchedule,
  customCron,
  cronError,
  savingSchedule,
  lastScheduledSync,
  onSyncScheduleChange,
  onCustomCronChange,
  onSaveSyncSchedule,
  lcDetectSchedule,
  isCustomLcDetect,
  customLcDetectCron,
  lcDetectCronError,
  savingLcDetect,
  lastLcDetect,
  onLcDetectScheduleChange,
  onCustomLcDetectCronChange,
  onSaveLcDetectSchedule,
  lcExecSchedule,
  isCustomLcExec,
  customLcExecCron,
  lcExecCronError,
  savingLcExec,
  lastLcExec,
  onLcExecScheduleChange,
  onCustomLcExecCronChange,
  onSaveLcExecSchedule,
  timezone,
  scheduleInfo,
  runningJob,
  onRunNow,
  formatDate,
  formatNextRun,
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4" />
            Daily Run Time
          </CardTitle>
          <CardDescription>
            Preset schedules (Daily, Weekly, Every 6h, Every 12h) run at this time, with sub-daily schedules using it as their starting anchor. Custom cron expressions ignore this setting and run at whatever times their expression specifies. All schedules use the server&apos;s local timezone.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      {/* Library Sync */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <RefreshCw className="h-4 w-4" />
            Library Sync
          </CardTitle>
          <CardDescription>
            How often Librariarr fetches metadata from your connected media servers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScheduleRow
            jobKey="sync"
            selectId="sync-schedule"
            label="Automatic sync frequency"
            schedule={syncSchedule}
            isCustom={isCustomSchedule}
            customCron={customCron}
            cronError={cronError}
            saving={savingSchedule}
            lastRun={lastScheduledSync}
            nextRun={scheduleInfo?.sync.nextRun ?? null}
            runningJob={runningJob}
            onScheduleChange={onSyncScheduleChange}
            onCustomCronChange={onCustomCronChange}
            onSaveCustomCron={onSaveSyncSchedule}
            onRunNow={onRunNow}
            formatDate={formatDate}
            formatNextRun={formatNextRun}
          />
        </CardContent>
      </Card>

      {/* Lifecycle Rules */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Workflow className="h-4 w-4" />
            Lifecycle Rules
          </CardTitle>
          <CardDescription>
            Detection scans for media matching rules; execution applies the scheduled actions.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <h4 className="text-sm font-medium mb-3">Detection</h4>
            <ScheduleRow
              jobKey="detection"
              selectId="lc-detect-schedule"
              label="Rule detection frequency"
              description="How often to scan for media matching lifecycle rules."
              schedule={lcDetectSchedule}
              isCustom={isCustomLcDetect}
              customCron={customLcDetectCron}
              cronError={lcDetectCronError}
              saving={savingLcDetect}
              lastRun={lastLcDetect}
              nextRun={scheduleInfo?.detection.nextRun ?? null}
              runningJob={runningJob}
              onScheduleChange={onLcDetectScheduleChange}
              onCustomCronChange={onCustomLcDetectCronChange}
              onSaveCustomCron={onSaveLcDetectSchedule}
              onRunNow={onRunNow}
              formatDate={formatDate}
              formatNextRun={formatNextRun}
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
              schedule={lcExecSchedule}
              isCustom={isCustomLcExec}
              customCron={customLcExecCron}
              cronError={lcExecCronError}
              saving={savingLcExec}
              lastRun={lastLcExec}
              nextRun={scheduleInfo?.execution.nextRun ?? null}
              runningJob={runningJob}
              onScheduleChange={onLcExecScheduleChange}
              onCustomCronChange={onCustomLcExecCronChange}
              onSaveCustomCron={onSaveLcExecSchedule}
              onRunNow={onRunNow}
              formatDate={formatDate}
              formatNextRun={formatNextRun}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
