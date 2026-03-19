"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Play } from "lucide-react";
import { SCHEDULE_OPTIONS } from "../types";
import type { ScheduleInfo } from "../types";

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
  runningJob: "sync" | "detection" | "execution" | null;
  onRunNow: (job: "sync" | "detection" | "execution") => void;

  // Helpers
  formatDate: (date: string | null) => string;
  formatNextRun: (nextRun: string | null, lastRun: string | null) => string;
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
    <div className="space-y-8">
      {/* Daily Run Time */}
      <section>
        <h2 className="text-xl font-semibold mb-4">Daily Run Time</h2>
        <Card>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <Label htmlFor="scheduled-job-time">Time of day for scheduled jobs</Label>
                <p className="text-xs text-muted-foreground mb-1.5">
                  All preset schedules run at this time (server local time). Sub-daily schedules (Every 6h, Every 12h) use this as their starting anchor. Custom cron expressions are not affected.
                  {timezone && (
                    <span className="block mt-0.5">
                      Server timezone: <span className="font-medium text-foreground/70">{timezone}</span>
                    </span>
                  )}
                </p>
                <div className="flex items-center gap-2">
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
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Sync Schedule */}
      <section>
        <h2 className="text-xl font-semibold mb-4">Library Sync</h2>
        <Card>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <Label htmlFor="sync-schedule">Automatic sync frequency</Label>
                <Select
                  value={syncSchedule}
                  onValueChange={onSyncScheduleChange}
                >
                  <SelectTrigger id="sync-schedule" className="mt-1.5 w-64">
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
                {isCustomSchedule && (
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
                        onClick={() => onSaveSyncSchedule(customCron)}
                        disabled={!customCron || savingSchedule}
                      >
                        {savingSchedule && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Save
                      </Button>
                    </div>
                    {cronError && (
                      <p className="mt-1 text-sm text-red-400">{cronError}</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      Standard 5-field cron expression (min hour dom mon dow).
                    </p>
                  </div>
                )}
              </div>
              <div className="text-sm text-muted-foreground text-right space-y-1">
                {savingSchedule ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <div>Last run: {formatDate(lastScheduledSync)}</div>
                    <div>Next run: {formatNextRun(scheduleInfo?.sync.nextRun ?? null, scheduleInfo?.sync.lastRun ?? null)}</div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1"
                      onClick={() => onRunNow("sync")}
                      disabled={!!runningJob}
                    >
                      {runningJob === "sync" ? (
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
          </CardContent>
        </Card>
      </section>

      {/* Lifecycle Schedule */}
      <section>
        <h2 className="text-xl font-semibold mb-4">Lifecycle Rules</h2>
        <Card>
          <CardContent className="space-y-6">
            {/* Detection Schedule */}
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <Label htmlFor="lc-detect-schedule">Rule detection frequency</Label>
                <p className="text-xs text-muted-foreground mb-1.5">
                  How often to scan for media matching lifecycle rules
                </p>
                <Select
                  value={lcDetectSchedule}
                  onValueChange={onLcDetectScheduleChange}
                >
                  <SelectTrigger id="lc-detect-schedule" className="w-64">
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
                {isCustomLcDetect && (
                  <div className="mt-3">
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="0 */4 * * *"
                        value={customLcDetectCron}
                        onChange={(e) => onCustomLcDetectCronChange(e.target.value)}
                        className="w-48 font-mono"
                      />
                      <Button
                        size="sm"
                        onClick={() => onSaveLcDetectSchedule(customLcDetectCron)}
                        disabled={!customLcDetectCron || savingLcDetect}
                      >
                        {savingLcDetect && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Save
                      </Button>
                    </div>
                    {lcDetectCronError && (
                      <p className="mt-1 text-sm text-red-400">{lcDetectCronError}</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      Standard 5-field cron expression.
                    </p>
                  </div>
                )}
              </div>
              <div className="text-sm text-muted-foreground text-right space-y-1">
                {savingLcDetect ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <div>Last run: {formatDate(lastLcDetect)}</div>
                    <div>Next run: {formatNextRun(scheduleInfo?.detection.nextRun ?? null, scheduleInfo?.detection.lastRun ?? null)}</div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1"
                      onClick={() => onRunNow("detection")}
                      disabled={!!runningJob}
                    >
                      {runningJob === "detection" ? (
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

            <div className="border-t" />

            {/* Execution Schedule */}
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <Label htmlFor="lc-exec-schedule">Action execution frequency</Label>
                <p className="text-xs text-muted-foreground mb-1.5">
                  How often to execute scheduled lifecycle actions
                </p>
                <Select
                  value={lcExecSchedule}
                  onValueChange={onLcExecScheduleChange}
                >
                  <SelectTrigger id="lc-exec-schedule" className="w-64">
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
                {isCustomLcExec && (
                  <div className="mt-3">
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="0 */4 * * *"
                        value={customLcExecCron}
                        onChange={(e) => onCustomLcExecCronChange(e.target.value)}
                        className="w-48 font-mono"
                      />
                      <Button
                        size="sm"
                        onClick={() => onSaveLcExecSchedule(customLcExecCron)}
                        disabled={!customLcExecCron || savingLcExec}
                      >
                        {savingLcExec && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Save
                      </Button>
                    </div>
                    {lcExecCronError && (
                      <p className="mt-1 text-sm text-red-400">{lcExecCronError}</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      Standard 5-field cron expression.
                    </p>
                  </div>
                )}
              </div>
              <div className="text-sm text-muted-foreground text-right space-y-1">
                {savingLcExec ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <div>Last run: {formatDate(lastLcExec)}</div>
                    <div>Next run: {formatNextRun(scheduleInfo?.execution.nextRun ?? null, scheduleInfo?.execution.lastRun ?? null)}</div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1"
                      onClick={() => onRunNow("execution")}
                      disabled={!!runningJob}
                    >
                      {runningJob === "execution" ? (
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
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
