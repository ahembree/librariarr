"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  Clapperboard,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Play,
  Calendar,
  Clock,
  AlertTriangle,
  CheckCircle,
  Combine,
  GripVertical,
  Shuffle,
  ListOrdered,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// --- Types ---

interface PrerollPreset {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

interface PrerollSchedule {
  id: string;
  name: string;
  enabled: boolean;
  prerollPath: string;
  scheduleType: string;
  startDate: string | null;
  endDate: string | null;
  daysOfWeek: number[] | null;
  startTime: string | null;
  endTime: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

// --- Constants ---

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Holiday presets: month/day based, year gets filled dynamically
const HOLIDAYS = [
  { name: "New Year's Day", startMonth: 1, startDay: 1, endMonth: 1, endDay: 2 },
  { name: "Valentine's Day", startMonth: 2, startDay: 14, endMonth: 2, endDay: 15 },
  { name: "St. Patrick's Day", startMonth: 3, startDay: 17, endMonth: 3, endDay: 18 },
  { name: "Easter", startMonth: 4, startDay: 1, endMonth: 4, endDay: 30 },
  { name: "Mother's Day", startMonth: 5, startDay: 1, endMonth: 5, endDay: 31 },
  { name: "Father's Day", startMonth: 6, startDay: 1, endMonth: 6, endDay: 30 },
  { name: "Independence Day (US)", startMonth: 7, startDay: 1, endMonth: 7, endDay: 5 },
  { name: "Halloween", startMonth: 10, startDay: 1, endMonth: 11, endDay: 1 },
  { name: "Thanksgiving (US)", startMonth: 11, startDay: 20, endMonth: 11, endDay: 30 },
  { name: "Christmas", startMonth: 12, startDay: 1, endMonth: 12, endDay: 26 },
  { name: "New Year's Eve", startMonth: 12, startDay: 31, endMonth: 12, endDay: 31 },
];

/** Format a Date as a datetime-local input value using the browser's local timezone. */
function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getHolidayDates(holiday: typeof HOLIDAYS[number], year: number) {
  const startDate = new Date(year, holiday.startMonth - 1, holiday.startDay, 0, 0);
  const endYear = holiday.endMonth < holiday.startMonth ? year + 1 : year;
  const endDate = new Date(endYear, holiday.endMonth - 1, holiday.endDay, 23, 59);
  return {
    startDate: toDatetimeLocalValue(startDate),
    endDate: toDatetimeLocalValue(endDate),
  };
}

// --- Helpers ---

function formatScheduleDescription(schedule: PrerollSchedule): string {
  if (schedule.scheduleType === "recurring") {
    const days = (schedule.daysOfWeek || [])
      .sort((a, b) => a - b)
      .map((d) => DAY_LABELS[d])
      .join(", ");
    const start = formatTimeDisplay(schedule.startTime || "00:00");
    const end = formatTimeDisplay(schedule.endTime || "23:59");
    return `Every ${days} ${start} - ${end}`;
  }

  if (schedule.scheduleType === "one_time" || schedule.scheduleType === "seasonal") {
    const start = schedule.startDate
      ? new Date(schedule.startDate).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "N/A";
    const end = schedule.endDate
      ? new Date(schedule.endDate).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "N/A";
    return `${start} - ${end}`;
  }

  return "Unknown schedule type";
}

function formatTimeDisplay(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${displayHour}:${String(m).padStart(2, "0")} ${period}`;
}

function formatScheduleTypeLabel(type: string): string {
  switch (type) {
    case "one_time":
      return "One-time";
    case "recurring":
      return "Recurring";
    case "seasonal":
      return "Seasonal";
    case "holiday":
      return "Holiday";
    default:
      return type;
  }
}

// --- Schedule Form State ---

interface ScheduleFormState {
  name: string;
  prerollPath: string;
  scheduleType: string;
  startDate: string;
  endDate: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  priority: number;
}

const EMPTY_SCHEDULE_FORM: ScheduleFormState = {
  name: "",
  prerollPath: "",
  scheduleType: "one_time",
  startDate: "",
  endDate: "",
  daysOfWeek: [],
  startTime: "00:00",
  endTime: "23:59",
  priority: 0,
};

function scheduleToForm(schedule: PrerollSchedule): ScheduleFormState {
  return {
    name: schedule.name,
    prerollPath: schedule.prerollPath,
    scheduleType: schedule.scheduleType,
    startDate: schedule.startDate
      ? toDatetimeLocalValue(new Date(schedule.startDate))
      : "",
    endDate: schedule.endDate
      ? toDatetimeLocalValue(new Date(schedule.endDate))
      : "",
    daysOfWeek: schedule.daysOfWeek || [],
    startTime: schedule.startTime || "00:00",
    endTime: schedule.endTime || "23:59",
    priority: schedule.priority,
  };
}

// --- Sortable Item for Combine Prerolls ---

function SortablePresetItem({
  id,
  name,
  path,
  onRemove,
}: {
  id: string;
  name: string;
  path: string;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 rounded-md border bg-card px-3 py-2",
        isDragging && "opacity-50 shadow-lg"
      )}
    >
      <button
        className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{name}</p>
        <p className="text-xs text-muted-foreground font-mono truncate">{path}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// --- Main Page ---

export default function PrerollManagerPage() {
  const [currentPreroll, setCurrentPreroll] = useState("");
  const [presets, setPresets] = useState<PrerollPreset[]>([]);
  const [schedules, setSchedules] = useState<PrerollSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasPlexServers, setHasPlexServers] = useState(true);
  const [applying, setApplying] = useState(false);
  const [quickSetPath, setQuickSetPath] = useState("");

  // Preset dialog
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetPath, setPresetPath] = useState("");
  const [presetSaving, setPresetSaving] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<{
    type: "preset" | "schedule";
    id: string;
    name: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Combine prerolls
  const [combineMode, setCombineMode] = useState<"sequential" | "random">("sequential");
  const [combineItems, setCombineItems] = useState<{ id: string; name: string; path: string }[]>([]);

  // File validation
  const [validationDialog, setValidationDialog] = useState<{
    open: boolean;
    path: string;
    onContinue: () => void;
  } | null>(null);

  // Schedule dialog
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<PrerollSchedule | null>(null);
  const [scheduleForm, setScheduleForm] = useState<ScheduleFormState>(EMPTY_SCHEDULE_FORM);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const [pageMessage, setPageMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // --- Data fetching ---

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/tools/preroll");
      if (res.ok) {
        const data = await res.json();
        setCurrentPreroll(data.currentPreroll ?? "");
        setPresets(data.presets ?? []);
        setSchedules(data.schedules ?? []);
        setHasPlexServers(data.hasPlexServers ?? false);
      }
    } catch {
      // Silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Poll every 30 seconds
  useEffect(() => {
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Auto-clear page messages
  useEffect(() => {
    if (!pageMessage) return;
    const timer = setTimeout(() => setPageMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [pageMessage]);

  // --- Actions ---

  const applyPreroll = async (path: string) => {
    setApplying(true);
    setPageMessage(null);
    try {
      const res = await fetch("/api/tools/preroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPageMessage({ type: "error", text: data.error || "Failed to apply preroll" });
        return;
      }
      const data = await res.json();
      setCurrentPreroll(path);
      setQuickSetPath("");
      if (data.errors && data.errors.length > 0) {
        setPageMessage({
          type: "error",
          text: `Preroll applied with errors: ${data.errors.join("; ")}`,
        });
      } else {
        setPageMessage({
          type: "success",
          text: path ? "Preroll applied successfully" : "Preroll cleared successfully",
        });
      }
    } catch {
      setPageMessage({ type: "error", text: "Network error applying preroll" });
    } finally {
      setApplying(false);
    }
  };

  const clearPreroll = async () => {
    await applyPreroll("");
  };

  // --- Preset CRUD ---

  const savePreset = async () => {
    if (!presetName.trim() || !presetPath.trim()) return;
    setPresetSaving(true);
    setPageMessage(null);
    try {
      const res = await fetch("/api/tools/preroll/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: presetName.trim(), path: presetPath.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPageMessage({ type: "error", text: data.error || "Failed to save preset" });
        return;
      }
      setPresetDialogOpen(false);
      setPresetName("");
      setPresetPath("");
      await fetchData();
      setPageMessage({ type: "success", text: "Preset saved" });
    } catch {
      setPageMessage({ type: "error", text: "Network error saving preset" });
    } finally {
      setPresetSaving(false);
    }
  };

  const deletePreset = async (id: string) => {
    setDeleting(true);
    setPageMessage(null);
    try {
      const res = await fetch(`/api/tools/preroll/presets/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPageMessage({ type: "error", text: data.error || "Failed to delete preset" });
        return;
      }
      await fetchData();
      setPageMessage({ type: "success", text: "Preset deleted" });
    } catch {
      setPageMessage({ type: "error", text: "Network error deleting preset" });
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  // --- Schedule CRUD ---

  const openNewSchedule = () => {
    setEditingSchedule(null);
    setScheduleForm(EMPTY_SCHEDULE_FORM);
    setScheduleError("");
    setScheduleDialogOpen(true);
  };

  const openEditSchedule = (schedule: PrerollSchedule) => {
    setEditingSchedule(schedule);
    setScheduleForm(scheduleToForm(schedule));
    setScheduleError("");
    setScheduleDialogOpen(true);
  };

  const saveSchedule = async () => {
    setScheduleSaving(true);
    setScheduleError("");

    // Holiday maps to "seasonal" on the API
    const apiScheduleType = scheduleForm.scheduleType === "holiday" ? "seasonal" : scheduleForm.scheduleType;
    const isDateType = ["one_time", "seasonal", "holiday"].includes(scheduleForm.scheduleType);

    const payload = {
      name: scheduleForm.name,
      prerollPath: scheduleForm.prerollPath,
      scheduleType: apiScheduleType,
      ...(isDateType
        ? {
            startDate: new Date(scheduleForm.startDate).toISOString(),
            endDate: new Date(scheduleForm.endDate).toISOString(),
          }
        : {}),
      ...(scheduleForm.scheduleType === "recurring"
        ? {
            daysOfWeek: scheduleForm.daysOfWeek,
            startTime: scheduleForm.startTime,
            endTime: scheduleForm.endTime,
          }
        : {}),
      priority: scheduleForm.priority,
    };

    try {
      const url = editingSchedule
        ? `/api/tools/preroll/schedules/${editingSchedule.id}`
        : "/api/tools/preroll/schedules";
      const method = editingSchedule ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.status === 409) {
        const data = await res.json();
        setScheduleError(
          `${data.error}: "${data.conflictingSchedule?.name}"`
        );
        return;
      }

      if (!res.ok) {
        const data = await res.json();
        setScheduleError(data.error || "Failed to save schedule");
        return;
      }

      setScheduleDialogOpen(false);
      setEditingSchedule(null);
      setScheduleForm(EMPTY_SCHEDULE_FORM);
      await fetchData();
    } catch {
      setScheduleError("Failed to save schedule");
    } finally {
      setScheduleSaving(false);
    }
  };

  const toggleScheduleEnabled = async (schedule: PrerollSchedule, enabled: boolean) => {
    setSchedules((prev) =>
      prev.map((s) => (s.id === schedule.id ? { ...s, enabled } : s))
    );
    try {
      const res = await fetch(`/api/tools/preroll/schedules/${schedule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        setSchedules((prev) =>
          prev.map((s) => (s.id === schedule.id ? { ...s, enabled: !enabled } : s))
        );
        setPageMessage({ type: "error", text: "Failed to update schedule" });
      }
    } catch {
      setSchedules((prev) =>
        prev.map((s) => (s.id === schedule.id ? { ...s, enabled: !enabled } : s))
      );
      setPageMessage({ type: "error", text: "Network error updating schedule" });
    }
  };

  const deleteSchedule = async (id: string) => {
    setDeleting(true);
    setPageMessage(null);
    try {
      const res = await fetch(`/api/tools/preroll/schedules/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPageMessage({ type: "error", text: data.error || "Failed to delete schedule" });
        return;
      }
      await fetchData();
      setPageMessage({ type: "success", text: "Schedule deleted" });
    } catch {
      setPageMessage({ type: "error", text: "Network error deleting schedule" });
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  // --- File Validation ---

  const validateAndApply = async (path: string) => {
    // Split by comma and semicolon to validate individual paths
    const paths = path.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
    const invalidPaths: string[] = [];

    for (const p of paths) {
      try {
        const res = await fetch("/api/tools/preroll/validate-path", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: p }),
        });
        const data = await res.json();
        if (!data.exists) invalidPaths.push(p);
      } catch {
        invalidPaths.push(p);
      }
    }

    if (invalidPaths.length > 0) {
      setValidationDialog({
        open: true,
        path: invalidPaths.join(", "),
        onContinue: () => {
          setValidationDialog(null);
          applyPreroll(path);
        },
      });
      return;
    }

    applyPreroll(path);
  };

  // --- Combine Prerolls ---

  const addToCombine = (preset: PrerollPreset) => {
    if (combineItems.some((item) => item.id === preset.id)) return;
    setCombineItems((prev) => [...prev, { id: preset.id, name: preset.name, path: preset.path }]);
  };

  const removeFromCombine = (id: string) => {
    setCombineItems((prev) => prev.filter((item) => item.id !== id));
  };

  const combinedPath = combineItems.length > 0
    ? combineItems.map((item) => item.path).join(combineMode === "sequential" ? "," : ";")
    : "";

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setCombineItems((items) => {
        const oldIndex = items.findIndex((i) => i.id === active.id);
        const newIndex = items.findIndex((i) => i.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const toggleDay = (day: number) => {
    setScheduleForm((prev) => ({
      ...prev,
      daysOfWeek: prev.daysOfWeek.includes(day)
        ? prev.daysOfWeek.filter((d) => d !== day)
        : [...prev.daysOfWeek, day].sort((a, b) => a - b),
    }));
  };

  // --- Render ---

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
          <Clapperboard className="h-7 w-7" />
          Preroll Manager
        </h1>
        <p className="text-muted-foreground mt-1">
          Manage preroll videos for your Plex servers
        </p>
      </div>

      {!loading && !hasPlexServers && (
        <Card className="border-yellow-500/50 bg-yellow-500/5">
          <CardContent className="flex items-center gap-3 py-4">
            <AlertTriangle className="h-5 w-5 text-yellow-500 shrink-0" />
            <p className="text-sm text-muted-foreground">
              Preroll management requires a Plex media server. Add a Plex server in Settings to use this feature.
            </p>
          </CardContent>
        </Card>
      )}

      {pageMessage && (
        <div
          className={cn(
            "flex items-center gap-2 rounded-md p-3 text-sm",
            pageMessage.type === "error"
              ? "bg-destructive/10 text-destructive"
              : "bg-green-500/10 text-green-500"
          )}
        >
          {pageMessage.type === "error" ? (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          ) : (
            <CheckCircle className="h-4 w-4 shrink-0" />
          )}
          {pageMessage.text}
        </div>
      )}

      {/* Section 1: Current Preroll */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current Preroll</CardTitle>
          <CardDescription>
            The preroll video path currently configured on your Plex server
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading...</span>
            </div>
          ) : currentPreroll ? (
            <div className="flex items-center justify-between gap-4">
              <code className="flex-1 rounded-md bg-muted px-3 py-2 text-sm font-mono break-all">
                {currentPreroll}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={clearPreroll}
                disabled={applying}
              >
                {applying ? (
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 mr-1.5" />
                )}
                Clear
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No preroll configured</p>
          )}
        </CardContent>
      </Card>

      {/* Section 2: Quick Set */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick Set</CardTitle>
          <CardDescription>
            Apply a preroll video path directly to your Plex server
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {presets.length > 0 && (
            <div className="space-y-2">
              <Label>Select from Presets</Label>
              <Select
                value={presets.some((p) => p.path === quickSetPath) ? quickSetPath : ""}
                onValueChange={(value) => setQuickSetPath(value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a preset..." />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((preset) => (
                    <SelectItem key={preset.id} value={preset.path}>
                      {preset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-2">
              <Label htmlFor="quick-set-path">
                {presets.length > 0 ? "Or enter a custom path" : "File Path"}
              </Label>
              <Input
                id="quick-set-path"
                placeholder="/path/to/preroll.mp4"
                value={quickSetPath}
                onChange={(e) => setQuickSetPath(e.target.value)}
              />
            </div>
            <Button
              onClick={() => validateAndApply(quickSetPath)}
              disabled={!quickSetPath.trim() || applying}
            >
              {applying ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-1.5" />
              )}
              Apply
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Section 2.5: Combine Prerolls */}
      {presets.length >= 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Combine className="h-4 w-4" />
              Combine Prerolls
            </CardTitle>
            <CardDescription>
              Combine multiple presets into a single preroll path. Plex supports comma-separated (sequential playback) and semicolon-separated (random selection) preroll lists.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Mode selector */}
            <div className="flex items-center gap-1 rounded-lg border p-1 w-fit">
              <button
                onClick={() => setCombineMode("sequential")}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  combineMode === "sequential"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                <ListOrdered className="h-3.5 w-3.5" />
                Sequential
              </button>
              <button
                onClick={() => setCombineMode("random")}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  combineMode === "random"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                <Shuffle className="h-3.5 w-3.5" />
                Random
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {combineMode === "sequential"
                ? "Prerolls will play in the order listed below, one after another."
                : "Plex will randomly select one preroll from the list each time."}
            </p>

            {/* Add presets */}
            <div className="space-y-2">
              <Label>Add Presets</Label>
              <div className="flex flex-wrap gap-2">
                {presets.map((preset) => {
                  const isAdded = combineItems.some((item) => item.id === preset.id);
                  return (
                    <button
                      key={preset.id}
                      onClick={() => isAdded ? removeFromCombine(preset.id) : addToCombine(preset)}
                      className={cn(
                        "rounded-md px-3 py-1.5 text-xs font-medium transition-colors border flex items-center gap-1.5",
                        isAdded
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-muted bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      {isAdded && <Check className="h-3 w-3" />}
                      {preset.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Sortable list (sequential mode only) */}
            {combineItems.length > 0 && (
              <div className="space-y-2">
                <Label>{combineMode === "sequential" ? "Playback Order" : "Selected Presets"}</Label>
                {combineMode === "sequential" ? (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={combineItems.map((i) => i.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-1.5">
                        {combineItems.map((item) => (
                          <SortablePresetItem
                            key={item.id}
                            id={item.id}
                            name={item.name}
                            path={item.path}
                            onRemove={() => removeFromCombine(item.id)}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                ) : (
                  <div className="space-y-1.5">
                    {combineItems.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center gap-2 rounded-md border bg-card px-3 py-2"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{item.name}</p>
                          <p className="text-xs text-muted-foreground font-mono truncate">{item.path}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeFromCombine(item.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Combined path preview + apply */}
            {combinedPath && (
              <div className="space-y-2">
                <Label>Combined Path</Label>
                <code className="block rounded-md bg-muted px-3 py-2 text-xs font-mono break-all">
                  {combinedPath}
                </code>
                <Button
                  onClick={() => validateAndApply(combinedPath)}
                  disabled={applying}
                  className="w-full sm:w-auto"
                >
                  {applying ? (
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4 mr-1.5" />
                  )}
                  Apply Combined Preroll
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Separator />

      {/* Section 3: Saved Presets */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Saved Presets</h2>
          <Button
            size="sm"
            onClick={() => {
              setPresetName("");
              setPresetPath(quickSetPath || currentPreroll || "");
              setPresetDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Save as Preset
          </Button>
        </div>

        {presets.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Clapperboard className="h-10 w-10 mb-3 opacity-30" />
              <p className="text-sm font-medium">No presets saved yet</p>
              <p className="text-xs mt-1">
                Save frequently used preroll paths as presets for quick access
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {presets.map((preset) => (
              <Card key={preset.id}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{preset.name}</p>
                      <code className="text-xs text-muted-foreground font-mono break-all">
                        {preset.path}
                      </code>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => validateAndApply(preset.path)}
                      disabled={applying}
                    >
                      {applying ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      Apply
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() =>
                        setDeleteTarget({
                          type: "preset",
                          id: preset.id,
                          name: preset.name,
                        })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Separator />

      {/* Section 4: Schedules */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Schedules
          </h2>
          <Button size="sm" onClick={openNewSchedule}>
            <Plus className="h-4 w-4 mr-1.5" />
            New Schedule
          </Button>
        </div>

        {schedules.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Calendar className="h-10 w-10 mb-3 opacity-30" />
              <p className="text-sm font-medium">No schedules configured</p>
              <p className="text-xs mt-1">
                Create schedules to automatically change preroll videos based on time
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {schedules.map((schedule) => (
              <Card
                key={schedule.id}
                className={cn(
                  !schedule.enabled && "opacity-60"
                )}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-sm">{schedule.name}</p>
                        <Badge variant="secondary" className="text-[10px] px-1.5">
                          {formatScheduleTypeLabel(schedule.scheduleType)}
                        </Badge>
                        <Badge variant="outline" className="text-[10px] px-1.5">
                          Priority: {schedule.priority}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span>{formatScheduleDescription(schedule)}</span>
                      </div>
                      <code className="text-xs text-muted-foreground font-mono break-all block">
                        {schedule.prerollPath}
                      </code>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Switch
                        checked={schedule.enabled}
                        onCheckedChange={(checked) =>
                          toggleScheduleEnabled(schedule, checked)
                        }
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEditSchedule(schedule)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() =>
                          setDeleteTarget({
                            type: "schedule",
                            id: schedule.id,
                            name: schedule.name,
                          })
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Preset Dialog */}
      <Dialog open={presetDialogOpen} onOpenChange={setPresetDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save Preset</DialogTitle>
            <DialogDescription>
              Save a preroll path as a reusable preset
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="preset-name">Name</Label>
              <Input
                id="preset-name"
                placeholder="e.g. Holiday Intro"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="preset-path">File Path</Label>
              <Input
                id="preset-path"
                placeholder="/path/to/preroll.mp4"
                value={presetPath}
                onChange={(e) => setPresetPath(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPresetDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={savePreset}
              disabled={!presetName.trim() || !presetPath.trim() || presetSaving}
            >
              {presetSaving ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-1.5" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Schedule Dialog */}
      <Dialog
        open={scheduleDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setScheduleDialogOpen(false);
            setEditingSchedule(null);
            setScheduleForm(EMPTY_SCHEDULE_FORM);
            setScheduleError("");
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingSchedule ? "Edit Schedule" : "New Schedule"}
            </DialogTitle>
            <DialogDescription>
              {editingSchedule
                ? "Update the schedule configuration"
                : "Create a new preroll schedule"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="schedule-name">Name</Label>
              <Input
                id="schedule-name"
                placeholder="e.g. Weekend Movie Night"
                value={scheduleForm.name}
                onChange={(e) =>
                  setScheduleForm((prev) => ({ ...prev, name: e.target.value }))
                }
              />
            </div>

            {/* Preroll Path */}
            <div className="space-y-2">
              <Label>Preroll Path</Label>
              {presets.length > 0 ? (
                <>
                  <Select
                    value={
                      presets.some((p) => p.path === scheduleForm.prerollPath)
                        ? scheduleForm.prerollPath
                        : "__custom__"
                    }
                    onValueChange={(value) => {
                      if (value === "__custom__") {
                        setScheduleForm((prev) => ({
                          ...prev,
                          prerollPath: "",
                        }));
                      } else {
                        setScheduleForm((prev) => ({
                          ...prev,
                          prerollPath: value,
                        }));
                      }
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a preset or custom path..." />
                    </SelectTrigger>
                    <SelectContent>
                      {presets.map((preset) => (
                        <SelectItem key={preset.id} value={preset.path}>
                          {preset.name}
                        </SelectItem>
                      ))}
                      <SelectItem value="__custom__">Custom path...</SelectItem>
                    </SelectContent>
                  </Select>
                  {!presets.some((p) => p.path === scheduleForm.prerollPath) && (
                    <Input
                      placeholder="/path/to/preroll.mp4"
                      value={scheduleForm.prerollPath}
                      onChange={(e) =>
                        setScheduleForm((prev) => ({
                          ...prev,
                          prerollPath: e.target.value,
                        }))
                      }
                      autoFocus
                    />
                  )}
                </>
              ) : (
                <Input
                  placeholder="/path/to/preroll.mp4"
                  value={scheduleForm.prerollPath}
                  onChange={(e) =>
                    setScheduleForm((prev) => ({
                      ...prev,
                      prerollPath: e.target.value,
                    }))
                  }
                />
              )}
            </div>

            {/* Schedule Type */}
            <div className="space-y-2">
              <Label>Schedule Type</Label>
              <Select
                value={scheduleForm.scheduleType}
                onValueChange={(value) =>
                  setScheduleForm((prev) => ({
                    ...prev,
                    scheduleType: value,
                    // Reset date fields when switching type
                    ...(value !== prev.scheduleType ? { startDate: "", endDate: "" } : {}),
                  }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="one_time">One-time</SelectItem>
                  <SelectItem value="recurring">Recurring</SelectItem>
                  <SelectItem value="seasonal">Seasonal</SelectItem>
                  <SelectItem value="holiday">Holiday</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Holiday selector */}
            {scheduleForm.scheduleType === "holiday" && (
              <div className="space-y-2">
                <Label>Holiday</Label>
                <Select
                  value=""
                  onValueChange={(value) => {
                    const holiday = HOLIDAYS.find((h) => h.name === value);
                    if (holiday) {
                      const year = new Date().getFullYear();
                      const dates = getHolidayDates(holiday, year);
                      setScheduleForm((prev) => ({
                        ...prev,
                        name: prev.name || holiday.name,
                        startDate: dates.startDate,
                        endDate: dates.endDate,
                      }));
                    }
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a holiday..." />
                  </SelectTrigger>
                  <SelectContent>
                    {HOLIDAYS.map((h) => (
                      <SelectItem key={h.name} value={h.name}>
                        {h.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Selecting a holiday pre-fills the date range for the current year. You can adjust dates below.
                </p>
              </div>
            )}

            {/* Conditional fields: One-time / Seasonal / Holiday */}
            {(scheduleForm.scheduleType === "one_time" ||
              scheduleForm.scheduleType === "seasonal" ||
              scheduleForm.scheduleType === "holiday") && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="schedule-start-date">Start Date</Label>
                  <Input
                    id="schedule-start-date"
                    type="datetime-local"
                    value={scheduleForm.startDate}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({
                        ...prev,
                        startDate: e.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="schedule-end-date">End Date</Label>
                  <Input
                    id="schedule-end-date"
                    type="datetime-local"
                    value={scheduleForm.endDate}
                    onChange={(e) =>
                      setScheduleForm((prev) => ({
                        ...prev,
                        endDate: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>
            )}

            {/* Conditional fields: Recurring */}
            {scheduleForm.scheduleType === "recurring" && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label>Days of Week</Label>
                  <div className="flex flex-wrap gap-2">
                    {DAY_LABELS.map((label, index) => (
                      <button
                        key={index}
                        type="button"
                        onClick={() => toggleDay(index)}
                        className={cn(
                          "rounded-md px-3 py-1.5 text-sm font-medium transition-colors border",
                          scheduleForm.daysOfWeek.includes(index)
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-muted bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="schedule-start-time">Start Time</Label>
                    <Input
                      id="schedule-start-time"
                      type="time"
                      value={scheduleForm.startTime}
                      onChange={(e) =>
                        setScheduleForm((prev) => ({
                          ...prev,
                          startTime: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="schedule-end-time">End Time</Label>
                    <Input
                      id="schedule-end-time"
                      type="time"
                      value={scheduleForm.endTime}
                      onChange={(e) =>
                        setScheduleForm((prev) => ({
                          ...prev,
                          endTime: e.target.value,
                        }))
                      }
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Priority */}
            <div className="space-y-2">
              <Label htmlFor="schedule-priority">Priority</Label>
              <Input
                id="schedule-priority"
                type="number"
                min={0}
                value={scheduleForm.priority}
                onChange={(e) =>
                  setScheduleForm((prev) => ({
                    ...prev,
                    priority: parseInt(e.target.value, 10) || 0,
                  }))
                }
                className="w-24"
              />
              <p className="text-[11px] text-muted-foreground">
                Higher priority schedules take precedence when multiple are active
              </p>
            </div>

            {/* Conflict error */}
            {scheduleError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3">
                <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <p className="text-sm text-destructive">{scheduleError}</p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setScheduleDialogOpen(false);
                setEditingSchedule(null);
                setScheduleForm(EMPTY_SCHEDULE_FORM);
                setScheduleError("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={saveSchedule}
              disabled={
                !scheduleForm.name.trim() ||
                !scheduleForm.prerollPath.trim() ||
                scheduleSaving
              }
            >
              {scheduleSaving ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : editingSchedule ? (
                <Pencil className="h-4 w-4 mr-1.5" />
              ) : (
                <Plus className="h-4 w-4 mr-1.5" />
              )}
              {editingSchedule ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* File Validation Warning Dialog */}
      <AlertDialog
        open={!!validationDialog?.open}
        onOpenChange={(open) => {
          if (!open) setValidationDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-400" />
              File Not Found
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                The following file path(s) could not be found:
              </span>
              <code className="block rounded-md bg-muted px-3 py-2 text-xs font-mono break-all">
                {validationDialog?.path}
              </code>
              <span className="block">
                Make sure the Plex media directory is mounted into the Librariarr container so file paths align. You can mount the media directory as read-only (e.g., <code className="text-xs">/media:/media:ro</code>).
              </span>
              <span className="block">Do you want to continue anyway?</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => validationDialog?.onContinue()}>
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.type === "preset" ? "Preset" : "Schedule"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{deleteTarget?.name}&rdquo;? This
              action cannot be undone.
              {deleteTarget?.type === "preset" && (
                <span className="block mt-2 text-muted-foreground">
                  The video file will not be deleted.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleteTarget) return;
                if (deleteTarget.type === "preset") {
                  deletePreset(deleteTarget.id);
                } else {
                  deleteSchedule(deleteTarget.id);
                }
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1.5" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
