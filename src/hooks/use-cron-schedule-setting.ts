"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

/** The schedule picker's value for "write my own cron expression". */
export const CUSTOM_SCHEDULE = "CUSTOM";

export interface CronScheduleSettingOptions {
  /** The route the schedule is saved to with a `PUT`, e.g. `/api/settings/sync-schedule`. */
  endpoint: string;
  /** The body field holding the schedule, e.g. `syncSchedule`. */
  bodyKey: string;
  /** Toasted once the route saved it, e.g. "Sync schedule saved". */
  successMsg: string;
  /** Re-read what the save moves (next run times); run after the route answers either way. */
  refresh?: () => unknown;
  /** The preset values the picker offers; anything else is a custom expression. */
  presets: readonly string[];
  /** Before the stored schedule is loaded. */
  initial: string;
}

export interface CronScheduleSetting {
  /** The picker's value: a preset, or `CUSTOM`. */
  schedule: string;
  isCustom: boolean;
  /** The custom expression being edited (or stored). */
  customCron: string;
  setCustomCron: (cron: string) => void;
  /** The route's refusal ("Invalid cron expression"), or "". */
  error: string;
  saving: boolean;
  /** The picker's change handler: a preset is saved at once; `CUSTOM` opens the expression field. */
  onScheduleChange: (value: string) => void;
  /** Save `value` (a preset, or the custom expression). */
  save: (value: string) => Promise<void>;
  /** Show a schedule read from the server: a preset as itself, anything else as a custom expression. */
  load: (stored: string) => void;
}

/**
 * One schedule setting on Settings → Scheduling (library sync, lifecycle
 * detection, lifecycle execution): a preset picker with a custom cron
 * expression, saved to its route. The page held the same six pieces of state
 * and three handlers for each of the three.
 */
export function useCronScheduleSetting({
  endpoint,
  bodyKey,
  successMsg,
  refresh,
  presets,
  initial,
}: CronScheduleSettingOptions): CronScheduleSetting {
  const [schedule, setSchedule] = useState(initial);
  const [isCustom, setIsCustom] = useState(false);
  const [customCron, setCustomCron] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = useCallback(
    async (value: string) => {
      setError("");
      setSaving(true);
      try {
        const response = await fetch(endpoint, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [bodyKey]: value }),
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          setError(data.error || "Failed to save schedule");
        } else {
          toast.success(successMsg);
        }
        await refresh?.();
      } catch (e) {
        console.error("Failed to save schedule:", e);
        setError("Failed to save schedule");
      } finally {
        setSaving(false);
      }
    },
    [endpoint, bodyKey, successMsg, refresh],
  );

  const onScheduleChange = useCallback(
    (value: string) => {
      setError("");
      if (value === CUSTOM_SCHEDULE) {
        setSchedule(CUSTOM_SCHEDULE);
        setIsCustom(true);
        return;
      }
      setSchedule(value);
      setIsCustom(false);
      setCustomCron("");
      void save(value);
    },
    [save],
  );

  const load = useCallback(
    (stored: string) => {
      if (presets.includes(stored)) {
        setSchedule(stored);
        setIsCustom(false);
      } else {
        setSchedule(CUSTOM_SCHEDULE);
        setIsCustom(true);
        setCustomCron(stored);
      }
    },
    [presets],
  );

  return { schedule, isCustom, customCron, setCustomCron, error, saving, onScheduleChange, save, load };
}
