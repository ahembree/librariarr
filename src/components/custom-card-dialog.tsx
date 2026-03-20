"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  BarChart3,
  PieChart as PieChartIcon,
  TrendingUp,
  Activity,
  Hexagon,
  LayoutGrid,
  Grid3x3,
  Hash,
  CalendarRange,
} from "lucide-react";
import { getDimensionsByGroup, DATE_DIMENSION_IDS } from "@/lib/dashboard/custom-dimensions";
import {
  HEATMAP_GRADIENTS,
  type CustomCardConfig,
  type CustomChartType,
  type CustomDimension,
  type TimelineBin,
} from "@/lib/dashboard/card-registry";

const CHART_TYPES: { type: CustomChartType; label: string; icon: typeof BarChart3 }[] = [
  { type: "bar", label: "Bar", icon: BarChart3 },
  { type: "pie", label: "Pie", icon: PieChartIcon },
  { type: "line", label: "Line", icon: TrendingUp },
  { type: "area", label: "Area", icon: Activity },
  { type: "radar", label: "Radar", icon: Hexagon },
  { type: "treemap", label: "Treemap", icon: LayoutGrid },
  { type: "heatmap", label: "Heatmap", icon: Grid3x3 },
  { type: "count", label: "Count", icon: Hash },
  { type: "timeline", label: "Timeline", icon: CalendarRange },
];

const dimensionGroups = getDimensionsByGroup();

interface CustomCardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (config: CustomCardConfig) => void;
  initialConfig?: CustomCardConfig;
}

export function CustomCardDialog({
  open,
  onOpenChange,
  onConfirm,
  initialConfig,
}: CustomCardDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <CustomCardDialogContent
          initialConfig={initialConfig}
          onConfirm={onConfirm}
          onCancel={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}

/** Inner form that resets state each time the dialog opens (remounted via conditional render) */
function CustomCardDialogContent({
  initialConfig,
  onConfirm,
  onCancel,
}: {
  initialConfig?: CustomCardConfig;
  onConfirm: (config: CustomCardConfig) => void;
  onCancel: () => void;
}) {
  const [chartType, setChartType] = useState<CustomChartType>(
    initialConfig?.chartType ?? "bar"
  );
  const [dimension, setDimension] = useState<CustomDimension | "">(
    initialConfig?.dimension ?? ""
  );
  const [title, setTitle] = useState(initialConfig?.title ?? "");
  const [topN, setTopN] = useState<number | null>(
    initialConfig?.topN !== undefined ? initialConfig.topN : 10
  );
  const [dimension2, setDimension2] = useState<CustomDimension | "">(
    initialConfig?.dimension2 ?? ""
  );
  const [heatmapGradient, setHeatmapGradient] = useState(
    initialConfig?.heatmapGradient ?? "red-green"
  );
  const [countValues, setCountValues] = useState<Set<string>>(
    new Set(initialConfig?.countValues ?? [])
  );
  const [timelineBin, setTimelineBin] = useState<TimelineBin>(
    initialConfig?.timelineBin ?? "month"
  );
  const [fetchedValues, setFetchedValues] = useState<{ key: string; values: string[] } | null>(null);

  const valuesKey = chartType === "count" && dimension ? dimension : "";
  const availableValues = fetchedValues?.key === valuesKey ? fetchedValues.values : [];
  const loadingValues = !!valuesKey && fetchedValues?.key !== valuesKey;

  // Fetch available values when dimension changes for count cards
  useEffect(() => {
    if (!valuesKey) return;
    let cancelled = false;
    fetch(`/api/media/stats/custom?dimension=${dimension}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const labels = (data.breakdown ?? [])
          .map((r: { value: string | null }) => r.value ?? "Unknown")
          .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
          .sort();
        setFetchedValues({ key: valuesKey, values: labels });
      })
      .catch(() => { if (!cancelled) setFetchedValues({ key: valuesKey, values: [] }); });
    return () => { cancelled = true; };
  }, [valuesKey, dimension]);

  const isEditing = !!initialConfig;
  const isTimeline = chartType === "timeline";
  const canSubmit = dimension !== ""
    && (chartType !== "heatmap" || dimension2 !== "")
    && (!isTimeline || DATE_DIMENSION_IDS.has(dimension));

  function handleSubmit() {
    if (!canSubmit) return;
    onConfirm({
      chartType,
      dimension: dimension as CustomDimension,
      ...(chartType === "heatmap" && dimension2 ? { dimension2: dimension2 as CustomDimension } : {}),
      ...(isTimeline && dimension2 ? { dimension2: dimension2 as CustomDimension } : {}),
      ...(chartType === "heatmap" ? { heatmapGradient } : {}),
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(chartType !== "count" ? { topN } : {}),
      ...(chartType === "count" && countValues.size > 0 ? { countValues: Array.from(countValues) } : {}),
      ...(isTimeline ? { timelineBin } : {}),
    });
  }

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{isEditing ? "Edit Custom Card" : "Add Custom Card"}</DialogTitle>
        <DialogDescription>
          Choose a chart type and data dimension to visualize.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5 py-2">
        {/* Chart type selector */}
        <div className="space-y-2">
          <Label>Chart Type</Label>
          <div className="flex flex-wrap gap-1.5">
            {CHART_TYPES.map(({ type, label, icon: Icon }) => (
              <button
                key={type}
                type="button"
                onClick={() => setChartType(type)}
                className={`flex min-w-14 flex-1 flex-col items-center gap-1.5 rounded-md border px-2 py-2.5 text-xs font-medium transition-colors ${
                  chartType === type
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Dimension selector */}
        <div className="space-y-2">
          <Label>{isTimeline ? "Date Field" : "Dimension"}</Label>
          <Select
            value={dimension}
            onValueChange={(val) => setDimension(val as CustomDimension)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={isTimeline ? "Select a date field..." : "Select a data dimension..."} />
            </SelectTrigger>
            <SelectContent>
              {Array.from(dimensionGroups.entries())
                .filter(([group]) => !isTimeline || group === "Dates")
                .map(([group, dims]) => (
                <SelectGroup key={group}>
                  <SelectLabel>{group}</SelectLabel>
                  {dims.map((dim) => (
                    <SelectItem key={dim.id} value={dim.id}>
                      {dim.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Time bin selector (timeline only) */}
        {isTimeline && (
          <div className="space-y-2">
            <Label>Time Interval</Label>
            <Select value={timelineBin} onValueChange={(val) => setTimelineBin(val as TimelineBin)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">Day</SelectItem>
                <SelectItem value="week">Week</SelectItem>
                <SelectItem value="month">Month</SelectItem>
                <SelectItem value="quarter">Quarter</SelectItem>
                <SelectItem value="year">Year</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Breakdown dimension (timeline) */}
        {isTimeline && (
          <div className="space-y-2">
            <Label>Color By <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Select
              value={dimension2 || "__none__"}
              onValueChange={(val) => setDimension2(val === "__none__" ? "" : val as CustomDimension)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="None — show total count" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {Array.from(dimensionGroups.entries())
                  .filter(([group]) => group !== "Dates")
                  .map(([group, dims]) => (
                  <SelectGroup key={group}>
                    <SelectLabel>{group}</SelectLabel>
                    {dims.map((dim) => (
                      <SelectItem key={dim.id} value={dim.id}>
                        {dim.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Second dimension (heatmap only) */}
        {chartType === "heatmap" && (
          <div className="space-y-2">
            <Label>Second Dimension (Y-Axis)</Label>
            <Select
              value={dimension2}
              onValueChange={(val) => setDimension2(val as CustomDimension)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select second dimension..." />
              </SelectTrigger>
              <SelectContent>
                {Array.from(dimensionGroups.entries()).map(([group, dims]) => (
                  <SelectGroup key={group}>
                    <SelectLabel>{group}</SelectLabel>
                    {dims
                      .filter((dim) => dim.id !== dimension)
                      .map((dim) => (
                        <SelectItem key={dim.id} value={dim.id}>
                          {dim.label}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Heatmap gradient (heatmap only) */}
        {chartType === "heatmap" && (
          <div className="space-y-2">
            <Label>Color Gradient</Label>
            <div className="flex flex-wrap gap-1.5">
              {HEATMAP_GRADIENTS.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setHeatmapGradient(g.id)}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                    heatmapGradient === g.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
                  }`}
                >
                  <div
                    className="h-3 w-8 rounded-sm"
                    style={{ background: `linear-gradient(to right, ${g.low}, ${g.high})` }}
                  />
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Top N (not applicable to count cards; timeline only when breakdown is set) */}
        {chartType !== "count" && (!isTimeline || dimension2) && <div className="space-y-2">
          <Label>Show Items</Label>
          <Select
            value={topN === null ? "all" : String(topN)}
            onValueChange={(val) => setTopN(val === "all" ? null : Number(val))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[5, 10, 15, 20].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  Top {n}
                </SelectItem>
              ))}
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>}

        {/* Value filter (count cards only) */}
        {chartType === "count" && dimension && (
          <div className="space-y-2">
            <Label>
              Count Values <span className="text-muted-foreground font-normal">(optional — all if none selected)</span>
            </Label>
            {loadingValues ? (
              <div className="text-sm text-muted-foreground">Loading...</div>
            ) : availableValues.length === 0 ? (
              <div className="text-sm text-muted-foreground">No values found</div>
            ) : (
              <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
                {availableValues.map((val) => {
                  const selected = countValues.has(val);
                  return (
                    <button
                      key={val}
                      type="button"
                      onClick={() => {
                        setCountValues((prev) => {
                          const next = new Set(prev);
                          if (next.has(val)) next.delete(val);
                          else next.add(val);
                          return next;
                        });
                      }}
                      className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                        selected
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-card text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground"
                      }`}
                    >
                      {val}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Optional title */}
        <div className="space-y-2">
          <Label>
            Title <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Auto-generated from dimension"
            maxLength={100}
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={!canSubmit}>
          {isEditing ? "Save" : "Add Card"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
