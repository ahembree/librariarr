"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  SlidersHorizontal,
  RefreshCw,
  Loader2,
  Play,
  Eye,
  ShieldCheck,
  AlertTriangle,
  Plus,
  X,
  CheckCircle2,
  ChevronRight,
  Settings2,
  MoreHorizontal,
  Server,
} from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ─── Types (mirror the API responses) ───

type ServiceType = "SONARR" | "RADARR";
type ResourceType = "CUSTOM_FORMAT" | "QUALITY_PROFILE" | "QUALITY_DEFINITION" | "NAMING";
type ItemStatus =
  | "NEW"
  | "UNMANAGED_CONFLICT"
  | "MANAGED"
  | "MANAGED_OUTDATED"
  | "MANAGED_MISSING";

interface GuideInstance {
  serviceType: ServiceType;
  id: string;
  name: string;
  enabled: boolean;
}

interface StatusItem {
  resourceType: ResourceType;
  trashId: string;
  name: string;
  description?: string;
  status: ItemStatus;
  existsInArr: boolean;
  managed: boolean;
  arrId?: number | null;
  managedResourceId?: string;
  lastSyncedAt?: string | null;
  selection?: NamingSelection | QualityProfileSelection | null;
}

interface TrashStatus {
  serviceType: ServiceType;
  instanceId: string;
  instanceName: string;
  reachable: boolean;
  error?: string;
  items: StatusItem[];
}

interface TrashNaming {
  folder?: Record<string, string>;
  file?: Record<string, string>;
  season?: Record<string, string>;
  series?: Record<string, string>;
  episodes?: {
    standard?: Record<string, string>;
    daily?: Record<string, string>;
    anime?: Record<string, string>;
  };
}

interface CatalogCf {
  trashId: string;
  name: string;
  defaultScore: number;
}

interface CfCategory {
  name: string;
  trashIds: string[];
}

interface CatalogSummary {
  service: ServiceType;
  ref: string;
  fetchedAt: string;
  counts: { customFormats: number; qualityProfiles: number; qualitySize: number; naming: number };
  naming: TrashNaming | null;
  customFormats?: CatalogCf[];
  categories?: CfCategory[];
  scoreSets?: string[];
}

interface ArrProfile {
  id: number;
  name: string;
  formatScores: Record<string, number>;
}

interface ProfileCfFormat {
  trashId: string;
  name: string;
  score: number;
}

interface ProfileCfAssignment {
  id: string;
  trashId: string; // profile name
  name: string;
  selection: { formats: ProfileCfFormat[] } | null;
}

interface DiffEntry {
  path: string;
  before: unknown;
  after: unknown;
  kind: "added" | "removed" | "changed";
}

interface PlanItem {
  resourceType: ResourceType;
  trashId: string;
  name: string;
  action: "CREATE" | "UPDATE" | "NOOP" | "SKIP" | "ERROR";
  diff: DiffEntry[];
  warnings: string[];
  error?: string;
  applied?: boolean;
}

interface SyncReport {
  serviceType: ServiceType;
  instanceId: string;
  dryRun: boolean;
  items: PlanItem[];
}

interface NamingSelection {
  folder?: string;
  file?: string;
  series?: string;
  season?: string;
  standard?: string;
  daily?: string;
  anime?: string;
}

interface QualityProfileSelection {
  scoreSet?: string;
  resetUnmatchedScores?: boolean;
  resetExcept?: string[];
  resetExceptPatterns?: string[];
}

// ─── Status presentation ───

const STATUS_META: Record<ItemStatus, { label: string; className: string; dot: string }> = {
  NEW: { label: "Not added", className: "border-white/15 text-muted-foreground", dot: "bg-muted-foreground/50" },
  UNMANAGED_CONFLICT: { label: "Exists — unmanaged", className: "border-amber/40 text-amber", dot: "bg-amber" },
  MANAGED: { label: "Managed", className: "border-green/40 text-green", dot: "bg-green" },
  MANAGED_OUTDATED: { label: "Update available", className: "border-blue-400/40 text-blue-400", dot: "bg-blue-400" },
  MANAGED_MISSING: { label: "Missing in app", className: "border-destructive/40 text-destructive", dot: "bg-destructive" },
};

const ACTION_META: Record<PlanItem["action"], { label: string; className: string }> = {
  CREATE: { label: "Create", className: "text-green" },
  UPDATE: { label: "Update", className: "text-blue-400" },
  NOOP: { label: "No change", className: "text-muted-foreground" },
  SKIP: { label: "Skipped", className: "text-amber" },
  ERROR: { label: "Error", className: "text-destructive" },
};

function fmt(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  const s = JSON.stringify(value);
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
}

/**
 * Group items by their TRaSH category (an item may appear under more than one).
 * Items in no category fall into a trailing "Uncategorized" group. Categories
 * with no matching items are omitted.
 */
function groupByCategory<T extends { trashId: string }>(
  items: T[],
  categories: CfCategory[],
): { name: string; items: T[] }[] {
  const byId = new Map(items.map((i) => [i.trashId, i]));
  const used = new Set<string>();
  const groups: { name: string; items: T[] }[] = [];
  for (const cat of categories) {
    const catItems = cat.trashIds
      .map((id) => byId.get(id))
      .filter((x): x is T => !!x);
    if (catItems.length) {
      groups.push({ name: cat.name, items: catItems });
      for (const i of catItems) used.add(i.trashId);
    }
  }
  const uncategorized = items.filter((i) => !used.has(i.trashId));
  if (uncategorized.length) groups.push({ name: "Uncategorized", items: uncategorized });
  return groups;
}

function CategorySection({
  name,
  count,
  expanded,
  onToggle,
  children,
}: {
  name: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 bg-white/[0.02] px-3 py-2 text-left hover:bg-white/5"
      >
        <ChevronRight className={cn("h-4 w-4 shrink-0 transition-transform", expanded && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
        <Badge variant="outline" className="shrink-0 text-[10.5px]">{count}</Badge>
      </button>
      {expanded && <div className="divide-y divide-white/5 border-t border-white/5">{children}</div>}
    </div>
  );
}

// ─── Page ───

export default function TrashSyncPage() {
  const [instances, setInstances] = useState<GuideInstance[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [status, setStatus] = useState<TrashStatus | null>(null);
  const [catalog, setCatalog] = useState<CatalogSummary | null>(null);
  const [loadingInstances, setLoadingInstances] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState(false);
  // A non-blocking status refresh after an action — keeps the list/tabs mounted
  // (only the first load and instance switches blank the view).
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Controlled so the active tab survives the status reload after an action
  // (the Tabs subtree unmounts while status is refetching, and an uncontrolled
  // Tabs would snap back to its default tab).
  const [activeTab, setActiveTab] = useState("profilecf");

  // Dialog state
  const [confirmItem, setConfirmItem] = useState<StatusItem | null>(null);
  const [optionsItem, setOptionsItem] = useState<StatusItem | null>(null);
  const [diffReport, setDiffReport] = useState<{ title: string; items: PlanItem[]; dryRun: boolean } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const selected = useMemo(
    () => instances.find((i) => `${i.serviceType}:${i.id}` === selectedKey) ?? null,
    [instances, selectedKey],
  );

  const loadInstances = useCallback(async () => {
    try {
      const res = await fetch("/api/tools/trash/instances");
      const data = await res.json();
      const list: GuideInstance[] = data.instances ?? [];
      setInstances(list);
      // Auto-select the first instance if none is chosen yet.
      setSelectedKey((prev) => prev || (list[0] ? `${list[0].serviceType}:${list[0].id}` : ""));
    } catch {
      toast.error("Failed to load integrations");
    } finally {
      setLoadingInstances(false);
    }
  }, []);

  const loadStatus = useCallback(
    async (inst: GuideInstance, opts: { refresh?: boolean; background?: boolean } = {}) => {
      // Background refresh (after an action): keep the current view mounted and
      // swap in the new data when it arrives, instead of blanking to a loader.
      if (opts.background) {
        setRefreshingStatus(true);
      } else {
        setLoadingStatus(true);
        setStatus(null);
      }
      try {
        const svc = inst.serviceType.toLowerCase();
        const [catRes, statusRes] = await Promise.all([
          fetch(`/api/tools/trash/catalog?service=${svc}${opts.refresh ? "&refresh=1" : ""}`),
          fetch(`/api/tools/trash/status?serviceType=${inst.serviceType}&instanceId=${inst.id}`),
        ]);
        const catData = await catRes.json();
        const statusData = await statusRes.json();
        if (catRes.ok) setCatalog(catData.catalog);
        if (statusRes.ok) {
          setStatus(statusData.status);
        } else {
          toast.error(statusData.error ?? "Failed to load status");
        }
      } catch {
        toast.error("Failed to load guide status");
      } finally {
        if (opts.background) setRefreshingStatus(false);
        else setLoadingStatus(false);
      }
    },
    [],
  );

  useEffect(() => {
    void (async () => {
      await loadInstances();
    })();
  }, [loadInstances]);

  useEffect(() => {
    if (!selected) return;
    // Fetch-on-select: the loading reset is a legitimate effect side-effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStatus(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, loadStatus]);

  const refreshGuides = async () => {
    if (!selected) return;
    setRefreshing(true);
    // In-place: the Refresh button shows its own spinner, so keep the list up.
    await loadStatus(selected, { refresh: true, background: true });
    setRefreshing(false);
    toast.success("Guide catalog refreshed");
  };

  // ─── Assign / unassign ───

  const assign = async (item: StatusItem, selection?: NamingSelection) => {
    if (!selected) return;
    setBusyId(item.trashId);
    try {
      const res = await fetch("/api/tools/trash/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceType: selected.serviceType,
          instanceId: selected.id,
          items: [
            {
              resourceType: item.resourceType,
              trashId: item.trashId,
              name: item.name,
              ...(selection ? { selection } : {}),
            },
          ],
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error ?? "Failed to assign");
        return;
      }
      toast.success(`Librariarr now manages “${item.name}”`);
      await loadStatus(selected, { background: true });
    } finally {
      setBusyId(null);
    }
  };

  const unassign = async (item: StatusItem) => {
    if (!selected || !item.managedResourceId) return;
    setBusyId(item.trashId);
    try {
      const res = await fetch(`/api/tools/trash/assignments/${item.managedResourceId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toast.error("Failed to stop managing");
        return;
      }
      toast.success(`Stopped managing “${item.name}” (unchanged in the app)`);
      await loadStatus(selected, { background: true });
    } finally {
      setBusyId(null);
    }
  };

  // Add a resource that does NOT exist in the app yet: assign it and create it
  // in one step. Safe without confirmation — there is nothing to overwrite.
  const addItem = async (item: StatusItem) => {
    if (!selected) return;
    setBusyId(item.trashId);
    try {
      const assignRes = await fetch("/api/tools/trash/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceType: selected.serviceType,
          instanceId: selected.id,
          items: [{ resourceType: item.resourceType, trashId: item.trashId, name: item.name }],
        }),
      });
      if (!assignRes.ok) {
        const d = await assignRes.json().catch(() => ({}));
        toast.error(d.error ?? "Failed to add");
        return;
      }
      const syncRes = await fetch("/api/tools/trash/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceType: selected.serviceType,
          instanceId: selected.id,
          dryRun: false,
          items: [{ resourceType: item.resourceType, trashId: item.trashId }],
        }),
      });
      const data = await syncRes.json();
      if (!syncRes.ok) {
        toast.error(data.error ?? "Added, but sync failed");
        await loadStatus(selected, { background: true });
        return;
      }
      const report: SyncReport = data.report;
      const errored = report.items.filter((i) => i.action === "ERROR").length;
      if (errored) toast.error(`Added “${item.name}” with errors`);
      else toast.success(`Added “${item.name}” to ${selected.name}`);
      setDiffReport({ title: `Add: ${item.name}`, items: report.items, dryRun: false });
      await loadStatus(selected, { background: true });
    } finally {
      setBusyId(null);
    }
  };

  // Persist a managed quality profile's per-profile options (score set +
  // reset-unmatched-scores). Records the intent only — the profile isn't
  // rewritten until the next Sync.
  const saveProfileOptions = async (item: StatusItem, selection: QualityProfileSelection) => {
    if (!selected || !item.managedResourceId) return;
    setBusyId(item.trashId);
    try {
      const res = await fetch(`/api/tools/trash/assignments/${item.managedResourceId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selection }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error ?? "Failed to save options");
        return;
      }
      toast.success(`Saved options for “${item.name}” (applied on next sync)`);
      setOptionsItem(null);
      await loadStatus(selected, { background: true });
    } finally {
      setBusyId(null);
    }
  };

  const onManageClick = (item: StatusItem) => {
    if (item.managed) {
      void unassign(item);
      return;
    }
    // Existing resources need explicit confirmation before Librariarr can
    // overwrite them on the next sync; not-yet-existing ones are just added.
    if (item.existsInArr) {
      setConfirmItem(item);
    } else {
      void addItem(item);
    }
  };

  // Bulk-add not-yet-existing resources: assign them all, then create them in
  // the app in one step. Only touches items with nothing to overwrite.
  const bulkAddItems = async (toAdd: StatusItem[]) => {
    if (!selected || !toAdd.length) return;
    setSyncing(true);
    try {
      const assignRes = await fetch("/api/tools/trash/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceType: selected.serviceType,
          instanceId: selected.id,
          items: toAdd.map((i) => ({ resourceType: i.resourceType, trashId: i.trashId, name: i.name })),
        }),
      });
      if (!assignRes.ok) {
        const d = await assignRes.json().catch(() => ({}));
        toast.error(d.error ?? "Failed to add");
        return;
      }
      const syncRes = await fetch("/api/tools/trash/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceType: selected.serviceType,
          instanceId: selected.id,
          dryRun: false,
          items: toAdd.map((i) => ({ resourceType: i.resourceType, trashId: i.trashId })),
        }),
      });
      const data = await syncRes.json();
      if (!syncRes.ok) {
        toast.error(data.error ?? "Added, but sync failed");
        await loadStatus(selected, { background: true });
        return;
      }
      const report: SyncReport = data.report;
      const errored = report.items.filter((i) => i.action === "ERROR").length;
      if (errored) toast.error(`Added ${toAdd.length} item(s) with ${errored} error(s)`);
      else toast.success(`Added ${toAdd.length} item${toAdd.length === 1 ? "" : "s"} to ${selected.name}`);
      setDiffReport({ title: `Add ${toAdd.length} item(s)`, items: report.items, dryRun: false });
      await loadStatus(selected, { background: true });
    } finally {
      setSyncing(false);
    }
  };

  // Bulk take-over: assign managed rows for existing resources (the consent
  // gate). Writes nothing to the app — the next sync overwrites them. The
  // caller (bulk bar) confirms the overwrite first.
  const bulkManageItems = async (toManage: StatusItem[]) => {
    if (!selected || !toManage.length) return;
    setSyncing(true);
    try {
      const res = await fetch("/api/tools/trash/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceType: selected.serviceType,
          instanceId: selected.id,
          items: toManage.map((i) => ({ resourceType: i.resourceType, trashId: i.trashId, name: i.name })),
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error ?? "Failed to manage");
        return;
      }
      toast.success(
        `Librariarr now manages ${toManage.length} item${toManage.length === 1 ? "" : "s"} — sync to apply`,
      );
      await loadStatus(selected, { background: true });
    } finally {
      setSyncing(false);
    }
  };

  // ─── Preview / sync ───

  const preview = async (
    item?: StatusItem,
    selection?: NamingSelection | QualityProfileSelection,
  ) => {
    if (!selected) return;
    setBusyId(item?.trashId ?? "__all__");
    try {
      const res = await fetch("/api/tools/trash/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceType: selected.serviceType,
          instanceId: selected.id,
          dryRun: true,
          ...(item
            ? {
                items: [
                  {
                    resourceType: item.resourceType,
                    trashId: item.trashId,
                    ...(selection ? { selection } : {}),
                  },
                ],
              }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Preview failed");
        return;
      }
      const report: SyncReport = data.report;
      setDiffReport({
        title: item ? `Preview: ${item.name}` : "Dry run — all managed resources",
        items: report.items,
        dryRun: true,
      });
    } finally {
      setBusyId(null);
    }
  };

  const applySync = async () => {
    if (!selected) return;
    setSyncing(true);
    try {
      const res = await fetch("/api/tools/trash/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceType: selected.serviceType,
          instanceId: selected.id,
          dryRun: false,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Sync failed");
        return;
      }
      const report: SyncReport = data.report;
      const changed = report.items.filter((i) => i.action === "CREATE" || i.action === "UPDATE").length;
      const errored = report.items.filter((i) => i.action === "ERROR").length;
      if (errored) toast.error(`Sync completed with ${errored} error${errored === 1 ? "" : "s"}`);
      else toast.success(changed ? `Synced ${changed} change${changed === 1 ? "" : "s"}` : "Everything already up to date");
      setDiffReport({ title: "Sync results", items: report.items, dryRun: false });
      await loadStatus(selected, { background: true });
    } finally {
      setSyncing(false);
    }
  };

  // Apply just one managed resource. The backend intersects `items` with the
  // managed set, so this only ever writes an already-assigned resource.
  const syncOne = async (item: StatusItem) => {
    if (!selected) return;
    setBusyId(item.trashId);
    try {
      const res = await fetch("/api/tools/trash/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceType: selected.serviceType,
          instanceId: selected.id,
          dryRun: false,
          items: [{ resourceType: item.resourceType, trashId: item.trashId }],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Sync failed");
        return;
      }
      const report: SyncReport = data.report;
      const errored = report.items.filter((i) => i.action === "ERROR").length;
      if (errored) toast.error(`“${item.name}” synced with errors`);
      else toast.success(`Synced “${item.name}”`);
      setDiffReport({ title: `Sync: ${item.name}`, items: report.items, dryRun: false });
      await loadStatus(selected, { background: true });
    } finally {
      setBusyId(null);
    }
  };

  // ─── Derived ───

  const counts = useMemo(() => {
    const c = { managed: 0, conflict: 0, outdated: 0, new: 0, missing: 0 };
    for (const i of status?.items ?? []) {
      if (i.status === "MANAGED") c.managed++;
      else if (i.status === "MANAGED_OUTDATED") { c.managed++; c.outdated++; }
      else if (i.status === "UNMANAGED_CONFLICT") c.conflict++;
      else if (i.status === "NEW") c.new++;
      else if (i.status === "MANAGED_MISSING") { c.managed++; c.missing++; }
    }
    return c;
  }, [status]);

  const cfItems = status?.items.filter((i) => i.resourceType === "CUSTOM_FORMAT") ?? [];
  const qpItems = status?.items.filter((i) => i.resourceType === "QUALITY_PROFILE") ?? [];
  const qdItem = status?.items.find((i) => i.resourceType === "QUALITY_DEFINITION");
  const namingItem = status?.items.find((i) => i.resourceType === "NAMING");

  return (
    <TooltipProvider delayDuration={200}>
    <div className="p-4 sm:p-6 lg:p-8 space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight flex items-center gap-2">
          <SlidersHorizontal className="h-7 w-7" />
          TRaSH Guide Sync
        </h1>
        <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
          Import recommended custom formats, quality profiles, sizes and naming into Sonarr /
          Radarr. Nothing is written until you assign it — preview every change first.
        </p>
      </div>

      {/* Toolbar: pick the target app, guide meta, refresh */}
      {loadingInstances ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading integrations…
        </div>
      ) : instances.length === 0 ? (
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">
            No Sonarr or Radarr integrations found. Add one under{" "}
            <span className="font-medium text-foreground">Settings → Integrations</span> first.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card/60 px-3 py-2.5">
          <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Select value={selectedKey} onValueChange={setSelectedKey}>
            <SelectTrigger className="h-9 w-64">
              <SelectValue placeholder="Select an app" />
            </SelectTrigger>
            <SelectContent>
              {instances.map((i) => (
                <SelectItem key={`${i.serviceType}:${i.id}`} value={`${i.serviceType}:${i.id}`}>
                  {i.name} · {i.serviceType === "SONARR" ? "Sonarr" : "Radarr"}
                  {!i.enabled ? " (disabled)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {catalog && (
            <span className="hidden text-xs text-muted-foreground md:inline">
              Guide {catalog.ref} · {catalog.counts.customFormats} formats ·{" "}
              {catalog.counts.qualityProfiles} profiles
            </span>
          )}
          {selected && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={refreshGuides}
              disabled={refreshing || loadingStatus}
            >
              <RefreshCw className={cn("mr-1.5 h-4 w-4", refreshing && "animate-spin")} />
              Refresh
            </Button>
          )}
        </div>
      )}

      {/* Status */}
      {selected && loadingStatus && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading {selected.name}…
        </div>
      )}

      {selected && !loadingStatus && status && !status.reachable && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center gap-2 py-4 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Couldn&apos;t reach {status.instanceName}: {status.error}
          </CardContent>
        </Card>
      )}

      {selected && !loadingStatus && status?.reachable && (
        <>
          {/* Status strip + global actions */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
              <CountPill dot="bg-green" label="managed" value={counts.managed} />
              {counts.outdated > 0 && <CountPill dot="bg-blue-400" label="update" value={counts.outdated} plural />}
              <CountPill dot="bg-amber" label="unmanaged" value={counts.conflict} />
              <CountPill dot="bg-muted-foreground/50" label="not added" value={counts.new} />
              {counts.missing > 0 && <CountPill dot="bg-destructive" label="missing" value={counts.missing} />}
              {refreshingStatus && (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating…
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => preview()}
                disabled={syncing || counts.managed === 0 || busyId === "__all__"}
              >
                {busyId === "__all__" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Eye className="mr-1.5 h-4 w-4" />}
                Dry run
              </Button>
              <Button size="sm" onClick={applySync} disabled={syncing || counts.managed === 0}>
                {syncing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
                Sync managed
              </Button>
            </div>
          </div>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="profilecf">Profile Formats</TabsTrigger>
              <TabsTrigger value="cf">Custom Formats ({cfItems.length})</TabsTrigger>
              <TabsTrigger value="qp">Quality Profiles ({qpItems.length})</TabsTrigger>
              <TabsTrigger value="misc">Sizes &amp; Naming</TabsTrigger>
            </TabsList>

            <TabsContent value="cf">
              <ResourceList
                items={cfItems}
                busyId={busyId}
                syncing={syncing}
                categories={catalog?.categories ?? []}
                onManage={onManageClick}
                onPreview={(i) => preview(i)}
                onSync={(i) => syncOne(i)}
                onBulkAdd={bulkAddItems}
                onBulkManage={bulkManageItems}
              />
            </TabsContent>

            <TabsContent value="qp">
              <ResourceList
                items={qpItems}
                busyId={busyId}
                syncing={syncing}
                onManage={onManageClick}
                // Preview a QP with its saved options so the per-row diff matches
                // what a real sync would do (score set / reset unmatched scores).
                onPreview={(i) => preview(i, (i.selection as QualityProfileSelection | null) ?? undefined)}
                onSync={(i) => syncOne(i)}
                onBulkAdd={bulkAddItems}
                onBulkManage={bulkManageItems}
                onOptions={(i) => setOptionsItem(i)}
              />
            </TabsContent>

            <TabsContent value="profilecf">
              <ProfileFormatsTab
                key={`${selected.serviceType}:${selected.id}`}
                serviceType={selected.serviceType}
                instanceId={selected.id}
                instanceName={selected.name}
                catalogCfs={catalog?.customFormats ?? []}
                catalogCategories={catalog?.categories ?? []}
                onShowReport={(title, items, dryRun) => setDiffReport({ title, items, dryRun })}
              />
            </TabsContent>

            <TabsContent value="misc" className="space-y-4">
              {qdItem && (
                <SingletonCard
                  item={qdItem}
                  busy={busyId === qdItem.trashId}
                  onManage={() => onManageClick(qdItem)}
                  onPreview={() => preview(qdItem)}
                  onSync={() => syncOne(qdItem)}
                />
              )}
              {namingItem && (
                <NamingCard
                  key={`${selected.serviceType}:${selected.id}`}
                  service={selected.serviceType}
                  item={namingItem}
                  naming={catalog?.naming ?? null}
                  busy={busyId === namingItem.trashId}
                  onManage={(sel) => assign(namingItem, sel)}
                  onUnmanage={() => unassign(namingItem)}
                  onPreview={(sel) => preview(namingItem, sel)}
                  onSync={() => syncOne(namingItem)}
                />
              )}
            </TabsContent>
          </Tabs>
        </>
      )}

      {/* Take-over confirmation */}
      <AlertDialog open={!!confirmItem} onOpenChange={(o) => !o && setConfirmItem(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Let Librariarr manage this?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">{confirmItem?.name}</span> already exists in{" "}
              {selected?.name}. Assigning it to Librariarr means the next sync will{" "}
              <span className="font-medium text-amber">overwrite</span> it with the TRaSH Guides
              version. You can preview the exact changes before syncing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmItem) void assign(confirmItem);
                setConfirmItem(null);
              }}
            >
              Manage &amp; allow overwrite
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Per-profile options (score set + reset unmatched scores) */}
      <QualityProfileOptionsDialog
        item={optionsItem}
        scoreSets={catalog?.scoreSets ?? []}
        busy={!!optionsItem && busyId === optionsItem.trashId}
        onClose={() => setOptionsItem(null)}
        onSave={(sel) => optionsItem && void saveProfileOptions(optionsItem, sel)}
      />

      {/* Diff / report dialog */}
      <Dialog open={!!diffReport} onOpenChange={(o) => !o && setDiffReport(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{diffReport?.title}</DialogTitle>
            <DialogDescription>
              {diffReport?.dryRun
                ? "Preview only — no changes have been made."
                : "The following changes were applied."}
            </DialogDescription>
          </DialogHeader>
          <ReportBody items={diffReport?.items ?? []} dryRun={diffReport?.dryRun ?? false} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiffReport(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
}

// ─── Small count pill for the status strip ───

function CountPill({
  dot,
  label,
  value,
  plural,
}: {
  dot: string;
  label: string;
  value: number;
  plural?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span className={cn("h-2 w-2 rounded-full", dot)} />
      <span className="tabular-nums font-medium text-foreground">{value}</span>
      {label}
      {plural && value !== 1 ? "s" : ""}
    </span>
  );
}

// ─── Resource list (custom formats / quality profiles) ───

function ResourceList({
  items,
  busyId,
  syncing,
  categories,
  onManage,
  onPreview,
  onSync,
  onBulkAdd,
  onBulkManage,
  onOptions,
}: {
  items: StatusItem[];
  busyId: string | null;
  /** A bulk operation is in flight (disables the selection actions). */
  syncing: boolean;
  /** When provided, items are grouped into an expandable category drilldown. */
  categories?: CfCategory[];
  onManage: (item: StatusItem) => void;
  onPreview: (item: StatusItem) => void;
  onSync: (item: StatusItem) => void;
  /** Assign + create the given not-yet-existing items. */
  onBulkAdd: (items: StatusItem[]) => Promise<void>;
  /** Take over (assign) the given existing items — caller confirms first here. */
  onBulkManage: (items: StatusItem[]) => Promise<void>;
  /** When provided, managed rows get an options (gear) button. */
  onOptions?: (item: StatusItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "managed" | "unmanaged" | "new">("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmManage, setConfirmManage] = useState(false);

  const filtered = items.filter((i) => {
    if (query && !i.name.toLowerCase().includes(query.toLowerCase())) return false;
    if (filter === "managed") return i.managed;
    if (filter === "unmanaged") return i.status === "UNMANAGED_CONFLICT";
    if (filter === "new") return i.status === "NEW";
    return true;
  });

  // Only not-yet-managed rows can be bulk-selected (to Add or take over).
  const selectableFiltered = filtered.filter((i) => !i.managed);
  const allSelected =
    selectableFiltered.length > 0 && selectableFiltered.every((i) => selected.has(i.trashId));
  const selectedItems = items.filter((i) => selected.has(i.trashId) && !i.managed);
  const selectedNew = selectedItems.filter((i) => i.status === "NEW");
  const selectedExisting = selectedItems.filter((i) => i.status === "UNMANAGED_CONFLICT");

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) selectableFiltered.forEach((i) => next.delete(i.trashId));
      else selectableFiltered.forEach((i) => next.add(i.trashId));
      return next;
    });
  const clearSelection = () => setSelected(new Set());

  const doAdd = async () => {
    await onBulkAdd(selectedNew);
    clearSelection();
  };
  const doManage = async () => {
    setConfirmManage(false);
    await onBulkManage(selectedExisting);
    clearSelection();
  };

  const grouped = categories && categories.length ? groupByCategory(filtered, categories) : null;
  // While searching, auto-expand everything so matches are visible.
  const searching = query.trim().length > 0;
  const isOpen = (name: string) => searching || expanded.has(name);
  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const renderRow = (item: StatusItem) => (
    <ResourceRow
      key={item.trashId}
      item={item}
      busy={busyId === item.trashId}
      selectable={!item.managed}
      selected={selected.has(item.trashId)}
      onToggleSelect={() => toggleOne(item.trashId)}
      onManage={() => onManage(item)}
      onPreview={() => onPreview(item)}
      onSync={() => onSync(item)}
      onOptions={onOptions ? () => onOptions(item) : undefined}
    />
  );

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex h-9 items-center pl-1 pr-1">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  disabled={selectableFiltered.length === 0}
                  aria-label="Select all shown"
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>Select all shown ({selectableFiltered.length})</TooltipContent>
          </Tooltip>
          <Input
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 min-w-[9rem] flex-1 sm:max-w-xs"
          />
          <Select value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <SelectTrigger className="h-9 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="managed">Managed</SelectItem>
              <SelectItem value="unmanaged">Unmanaged (exists)</SelectItem>
              <SelectItem value="new">Not added</SelectItem>
            </SelectContent>
          </Select>
          {grouped && grouped.length > 0 && !searching && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() =>
                setExpanded((prev) =>
                  prev.size >= grouped.length ? new Set() : new Set(grouped.map((g) => g.name)),
                )
              }
            >
              {expanded.size >= grouped.length ? "Collapse all" : "Expand all"}
            </Button>
          )}
        </div>

        {/* Bulk action bar — appears once anything is selected. */}
        {selectedItems.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
            <span className="text-sm font-medium">
              {selectedItems.length} selected
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {selectedNew.length > 0 && (
                <Button size="sm" onClick={doAdd} disabled={syncing}>
                  {syncing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
                  Add ({selectedNew.length})
                </Button>
              )}
              {selectedExisting.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmManage(true)}
                  disabled={syncing}
                  title="Take over management — the next sync overwrites the app copies"
                >
                  <ShieldCheck className="mr-1.5 h-4 w-4" />
                  Manage ({selectedExisting.length})
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={clearSelection} disabled={syncing}>
                Clear
              </Button>
            </div>
          </div>
        )}

        {/* Native vertical scroll (not shadcn ScrollArea): its inner
            display:table wrapper lets long rows grow horizontally, which pushed
            the action buttons off-screen. overflow-x-hidden keeps rows bounded
            so the description truncates and the buttons stay visible. */}
        <div className="max-h-[30rem] overflow-y-auto overflow-x-hidden rounded-md border border-white/5">
          {filtered.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No items match.</p>
          ) : grouped ? (
            <div className="divide-y divide-white/5">
              {grouped.map((g) => (
                <CategorySection
                  key={g.name}
                  name={g.name}
                  count={g.items.length}
                  expanded={isOpen(g.name)}
                  onToggle={() => toggle(g.name)}
                >
                  {g.items.map(renderRow)}
                </CategorySection>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-white/5">{filtered.map(renderRow)}</div>
          )}
        </div>
      </CardContent>

      {/* Bulk take-over confirmation */}
      <AlertDialog open={confirmManage} onOpenChange={(o) => !o && setConfirmManage(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Manage {selectedExisting.length} existing item{selectedExisting.length === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              These already exist in the app. Assigning them to Librariarr means the next sync will{" "}
              <span className="font-medium text-amber">overwrite</span> them with the TRaSH Guides
              versions. Nothing changes in the app until you sync.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doManage}>Manage &amp; allow overwrite</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function ResourceRow({
  item,
  busy,
  selectable,
  selected,
  onToggleSelect,
  onManage,
  onPreview,
  onSync,
  onOptions,
}: {
  item: StatusItem;
  busy: boolean;
  /** Not-yet-managed rows can be checked for a bulk Add / Manage. */
  selectable: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onManage: () => void;
  onPreview: () => void;
  onSync: () => void;
  /** When provided and the item is managed, shows an options (gear) button. */
  onOptions?: () => void;
}) {
  const meta = STATUS_META[item.status];
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2 transition-colors hover:bg-white/[0.02]",
        selected && "bg-primary/5",
      )}
    >
      {/* Selection checkbox (only for not-yet-managed rows); a fixed-width slot
          keeps the status dot aligned across selectable and managed rows. */}
      <span className="flex w-4 shrink-0 justify-center">
        {selectable && (
          <Checkbox checked={selected} onCheckedChange={onToggleSelect} aria-label={`Select ${item.name}`} />
        )}
      </span>
      {/* Status is a compact colored dot; the legend lives in the status strip. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("h-2 w-2 shrink-0 rounded-full", meta.dot)} />
        </TooltipTrigger>
        <TooltipContent>{meta.label}</TooltipContent>
      </Tooltip>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{item.name}</div>
        {item.description && (
          <p className="truncate text-xs text-muted-foreground">{item.description}</p>
        )}
      </div>

      {/* Actions never shrink, so a long description can't push them off-row.
          Preview stays visible (core to the consent flow); the primary action is
          one button; secondary options collapse into an overflow menu. */}
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              onClick={onPreview}
              disabled={busy}
            >
              <Eye className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Preview diff</TooltipContent>
        </Tooltip>

        {item.managed ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              className="w-20"
              onClick={onSync}
              disabled={busy}
              title="Sync just this item"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Play className="mr-1 h-3.5 w-3.5" /> Sync</>}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" disabled={busy}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {onOptions && (
                  <>
                    <DropdownMenuItem onSelect={() => onOptions()}>
                      <Settings2 className="mr-2 h-4 w-4" /> Options…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onSelect={() => onManage()}>
                  <X className="mr-2 h-4 w-4" /> Stop managing
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : (
          <Button
            variant={item.existsInArr ? "outline" : "default"}
            size="sm"
            onClick={onManage}
            disabled={busy}
            className="w-24"
            title={
              item.existsInArr
                ? "Take over management — the next sync overwrites the app copy"
                : "Add this to the app now"
            }
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : item.existsInArr ? (
              <>
                <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Manage
              </>
            ) : (
              <>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Quality-definition (singleton) card ───

function SingletonCard({
  item,
  busy,
  onManage,
  onPreview,
  onSync,
}: {
  item: StatusItem;
  busy: boolean;
  onManage: () => void;
  onPreview: () => void;
  onSync: () => void;
}) {
  const meta = STATUS_META[item.status];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">{item.name}</CardTitle>
            <CardDescription>{item.description}</CardDescription>
          </div>
          <Badge variant="outline" className={meta.className}>{meta.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onPreview} disabled={busy}>
          <Eye className="mr-1 h-3.5 w-3.5" /> Preview diff
        </Button>
        {item.managed && (
          <Button variant="secondary" size="sm" onClick={onSync} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
            Sync now
          </Button>
        )}
        <Button variant={item.managed ? "outline" : "default"} size="sm" onClick={onManage} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : item.managed ? "Stop managing" : "Manage sizes"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Naming card (variant selectors) ───

function NamingCard({
  service,
  item,
  naming,
  busy,
  onManage,
  onUnmanage,
  onPreview,
  onSync,
}: {
  service: ServiceType;
  item: StatusItem;
  naming: TrashNaming | null;
  busy: boolean;
  onManage: (selection: NamingSelection) => void;
  onUnmanage: () => void;
  onPreview: (selection: NamingSelection) => void;
  onSync: () => void;
}) {
  // Seed from the currently-managed selection so a managed naming item shows
  // its variants (the card is keyed per instance, so this re-seeds on switch).
  const [sel, setSel] = useState<NamingSelection>((item.selection as NamingSelection | null) ?? {});
  const meta = STATUS_META[item.status];

  const groups: { key: keyof NamingSelection; label: string; options: Record<string, string> }[] = [];
  if (naming) {
    if (service === "RADARR") {
      if (naming.file) groups.push({ key: "file", label: "Movie file", options: naming.file });
      if (naming.folder) groups.push({ key: "folder", label: "Movie folder", options: naming.folder });
    } else {
      if (naming.series) groups.push({ key: "series", label: "Series folder", options: naming.series });
      if (naming.season) groups.push({ key: "season", label: "Season folder", options: naming.season });
      if (naming.episodes?.standard) groups.push({ key: "standard", label: "Standard episode", options: naming.episodes.standard });
      if (naming.episodes?.daily) groups.push({ key: "daily", label: "Daily episode", options: naming.episodes.daily });
      if (naming.episodes?.anime) groups.push({ key: "anime", label: "Anime episode", options: naming.episodes.anime });
    }
  }

  const hasSelection = Object.values(sel).some(Boolean);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">{item.name}</CardTitle>
            <CardDescription>
              Choose the naming variants to apply, then let Librariarr manage them.
            </CardDescription>
          </div>
          <Badge variant="outline" className={meta.className}>{meta.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">Guide naming data unavailable.</p>
        ) : (
          groups.map((g) => (
            <div key={g.key} className="space-y-1.5">
              <Label className="text-xs">{g.label}</Label>
              <Select
                value={sel[g.key] ?? ""}
                onValueChange={(v) => setSel((s) => ({ ...s, [g.key]: v }))}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Keep current" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(g.options).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      <span className="font-medium">{k}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{v}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {sel[g.key] && (
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {g.options[sel[g.key]!]}
                </p>
              )}
            </div>
          ))
        )}
        <div className="flex items-center gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => onPreview(sel)} disabled={busy || !hasSelection}>
            <Eye className="mr-1 h-3.5 w-3.5" /> Preview diff
          </Button>
          <Button size="sm" onClick={() => onManage(sel)} disabled={busy || !hasSelection}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1 h-3.5 w-3.5" />}
            {item.managed ? "Update selection" : "Manage naming"}
          </Button>
          {item.managed && (
            <Button variant="secondary" size="sm" onClick={onSync} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
              Sync now
            </Button>
          )}
          {item.managed && (
            <Button variant="outline" size="sm" onClick={onUnmanage} disabled={busy}>
              Stop managing
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Profile custom-format assignment ───

/** Assigned formats are shown highest-score-first (ties broken by name). */
function sortFormatsByScore(list: ProfileCfFormat[]): ProfileCfFormat[] {
  return [...list].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function ProfileFormatsTab({
  serviceType,
  instanceId,
  instanceName,
  catalogCfs,
  catalogCategories,
  onShowReport,
}: {
  serviceType: ServiceType;
  instanceId: string;
  instanceName: string;
  catalogCfs: CatalogCf[];
  catalogCategories: CfCategory[];
  onShowReport: (title: string, items: PlanItem[], dryRun: boolean) => void;
}) {
  const [profiles, setProfiles] = useState<ArrProfile[]>([]);
  const [assignments, setAssignments] = useState<ProfileCfAssignment[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const [formats, setFormats] = useState<ProfileCfFormat[]>([]);
  // Custom-format names that actually exist in the app — a score only applies to
  // one of these, so an assigned format outside this set is flagged inline.
  const [instanceFormats, setInstanceFormats] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [cfQuery, setCfQuery] = useState("");
  const [pickerExpanded, setPickerExpanded] = useState<Set<string>>(new Set());
  const [attachedQuery, setAttachedQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, aRes] = await Promise.all([
        fetch(`/api/tools/trash/profiles?serviceType=${serviceType}&instanceId=${instanceId}`),
        fetch(`/api/tools/trash/assignments?serviceType=${serviceType}&instanceId=${instanceId}`),
      ]);
      const pData = await pRes.json();
      const aData = await aRes.json();
      if (pRes.ok) {
        setProfiles(pData.profiles ?? []);
        setInstanceFormats(new Set<string>(pData.instanceFormatNames ?? []));
        setError(null);
      } else {
        setError(pData.error ?? "Failed to load quality profiles");
      }
      if (aRes.ok) {
        setAssignments(
          (aData.assignments ?? []).filter(
            (x: { resourceType: string }) => x.resourceType === "PROFILE_CF",
          ),
        );
      }
    } catch {
      setError("Failed to load quality profiles");
    } finally {
      setLoading(false);
    }
  }, [serviceType, instanceId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const assignmentFor = (name: string) => assignments.find((a) => a.trashId === name);
  const currentAssignment = selectedProfile ? assignmentFor(selectedProfile) : undefined;
  const currentProfile = profiles.find((p) => p.name === selectedProfile);

  // Managed profiles (those with a saved PROFILE_CF assignment), always listed
  // so they can be jumped to without opening the dropdown.
  const managedProfileNames = useMemo(
    () => [...assignments.map((a) => a.trashId)].sort((a, b) => a.localeCompare(b)),
    [assignments],
  );

  // Guide custom formats keyed by lowercased name (to map a profile's current
  // scores — which are keyed by name — back to guide trash_ids).
  const cfByName = useMemo(() => {
    const m = new Map<string, CatalogCf>();
    for (const cf of catalogCfs) m.set(cf.name.toLowerCase(), cf);
    return m;
  }, [catalogCfs]);

  // A score only applies to a custom format that already exists in the app. When
  // we know the instance's format names, flag any assigned format outside that
  // set (mirrors the backend's exact-name presence check). If we don't have the
  // list yet, assume present so nothing is falsely flagged.
  const isInApp = (name: string) => instanceFormats.size === 0 || instanceFormats.has(name);

  // Unsaved-edit guard: a real (non-dry-run) Sync applies the STORED selection,
  // so syncing with unsaved edits would silently apply stale scores while
  // Preview shows the live ones. Disable Sync until the edits are saved.
  const formatsKey = (fmts?: ProfileCfFormat[] | null) =>
    JSON.stringify(
      (fmts ?? []).map((f) => [f.trashId, f.score]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    );
  const isDirty =
    !!currentAssignment &&
    formatsKey(formats) !== formatsKey(currentAssignment.selection?.formats);

  // Assigned formats that don't yet exist in the app (their score can't apply).
  const missingFormats = formats.filter((f) => !isInApp(f.name));

  const selectProfile = (name: string) => {
    setSelectedProfile(name);
    setCfQuery("");
    setAttachedQuery("");
    const profile = profiles.find((p) => p.name === name);
    const existing = assignmentFor(name);
    // Seed with every guide custom format currently scored on the profile, so
    // all assigned formats are listed and their scores can be overridden…
    const byTrashId = new Map<string, ProfileCfFormat>();
    for (const [cfName, score] of Object.entries(profile?.formatScores ?? {})) {
      const guideCf = cfByName.get(cfName.toLowerCase());
      if (guideCf) byTrashId.set(guideCf.trashId, { trashId: guideCf.trashId, name: guideCf.name, score });
    }
    // …then layer the user's saved overrides on top.
    for (const f of existing?.selection?.formats ?? []) byTrashId.set(f.trashId, { ...f });
    setFormats(sortFormatsByScore([...byTrashId.values()]));
  };

  const addFormat = (cf: CatalogCf) => {
    if (formats.some((f) => f.trashId === cf.trashId)) return;
    // Re-sort on add so the new format lands in its score position. Inline score
    // edits intentionally don't re-sort (that would make the row jump while typing).
    setFormats((prev) => sortFormatsByScore([...prev, { trashId: cf.trashId, name: cf.name, score: cf.defaultScore }]));
    setCfQuery("");
  };
  const removeFormat = (trashId: string) =>
    setFormats((prev) => prev.filter((f) => f.trashId !== trashId));
  const setScore = (trashId: string, score: number) =>
    setFormats((prev) => prev.map((f) => (f.trashId === trashId ? { ...f, score } : f)));

  const save = async () => {
    if (!selectedProfile) return;
    setBusy(true);
    try {
      const res = await fetch("/api/tools/trash/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceType,
          instanceId,
          items: [
            {
              resourceType: "PROFILE_CF",
              trashId: selectedProfile,
              name: selectedProfile,
              selection: { formats },
            },
          ],
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? "Failed to save");
        return;
      }
      toast.success(`Saved custom formats for “${selectedProfile}” (not applied until you Sync)`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const runSync = async (dryRun: boolean) => {
    if (!selectedProfile) return;
    setBusy(true);
    try {
      const res = await fetch("/api/tools/trash/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceType,
          instanceId,
          dryRun,
          items: [
            {
              resourceType: "PROFILE_CF",
              trashId: selectedProfile,
              // dry-run previews the current (possibly unsaved) edits.
              ...(dryRun ? { selection: { formats } } : {}),
            },
          ],
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? "Sync failed");
        return;
      }
      const items: PlanItem[] = d.report.items;
      if (!dryRun) {
        const errored = items.filter((i) => i.action === "ERROR").length;
        if (errored) toast.error(`Applied with ${errored} error(s)`);
        else toast.success(`Applied custom-format scores to “${selectedProfile}”`);
        await load();
      }
      onShowReport(
        dryRun ? `Preview: ${selectedProfile}` : `Applied: ${selectedProfile}`,
        items,
        dryRun,
      );
    } finally {
      setBusy(false);
    }
  };

  const unmanage = async () => {
    if (!currentAssignment) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tools/trash/assignments/${currentAssignment.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toast.error("Failed to stop managing");
        return;
      }
      toast.success("Stopped managing (existing scores left unchanged in the app)");
      await load();
    } finally {
      setBusy(false);
    }
  };

  // One-click "add & score": create the missing custom format(s) in the app
  // (the consent-gated write), then persist and sync this profile's selection so
  // the scores actually apply — without leaving the tab.
  const addToAppAndApply = async (toAdd: ProfileCfFormat[]) => {
    if (!selectedProfile || toAdd.length === 0) return;
    const postJson = (url: string, body: unknown) =>
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(true);
    try {
      const cfItems = toAdd.map((f) => ({ resourceType: "CUSTOM_FORMAT", trashId: f.trashId, name: f.name }));
      // 1) Assign + create the custom format(s) in the app.
      const assignRes = await postJson("/api/tools/trash/assignments", { serviceType, instanceId, items: cfItems });
      if (!assignRes.ok) {
        const d = await assignRes.json().catch(() => ({}));
        toast.error(d.error ?? "Failed to add to app");
        return;
      }
      const cfSync = await postJson("/api/tools/trash/sync", {
        serviceType,
        instanceId,
        dryRun: false,
        items: cfItems.map((i) => ({ resourceType: i.resourceType, trashId: i.trashId })),
      });
      if (!cfSync.ok) {
        const d = await cfSync.json().catch(() => ({}));
        toast.error(d.error ?? "Failed to create in app");
        await load();
        return;
      }
      // 2) Persist this profile's custom-format selection.
      const saveRes = await postJson("/api/tools/trash/assignments", {
        serviceType,
        instanceId,
        items: [{ resourceType: "PROFILE_CF", trashId: selectedProfile, name: selectedProfile, selection: { formats } }],
      });
      if (!saveRes.ok) {
        const d = await saveRes.json().catch(() => ({}));
        toast.error(d.error ?? "Added to app, but failed to save the profile");
        await load();
        return;
      }
      // 3) Apply the profile scores now that the format(s) exist.
      const pfSync = await postJson("/api/tools/trash/sync", {
        serviceType,
        instanceId,
        dryRun: false,
        items: [{ resourceType: "PROFILE_CF", trashId: selectedProfile }],
      });
      const d = await pfSync.json();
      if (!pfSync.ok) {
        toast.error(d.error ?? "Added to app, but the profile sync failed");
        await load();
        return;
      }
      const errored = (d.report?.items ?? []).filter((i: PlanItem) => i.action === "ERROR").length;
      if (errored) toast.error(`Applied with ${errored} error(s)`);
      else
        toast.success(
          `Added ${toAdd.length} custom format${toAdd.length === 1 ? "" : "s"} to ${instanceName} and applied the scores`,
        );
      onShowReport(`Add & apply: ${selectedProfile}`, d.report?.items ?? [], false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  // Addable custom formats (not already attached), grouped into the guide's
  // categories for the drilldown picker.
  const attachedIds = new Set(formats.map((f) => f.trashId));
  const addableCfs = catalogCfs
    .filter((cf) => !attachedIds.has(cf.trashId))
    .filter((cf) => !cfQuery || cf.name.toLowerCase().includes(cfQuery.toLowerCase()));
  const addableGroups = catalogCategories.length
    ? groupByCategory(addableCfs, catalogCategories)
    : [{ name: "All custom formats", items: addableCfs }];
  const pickerSearching = cfQuery.trim().length > 0;
  const isPickerOpen = (name: string) => pickerSearching || pickerExpanded.has(name);
  const togglePicker = (name: string) =>
    setPickerExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Attach custom formats to a quality profile</CardTitle>
        <CardDescription>
          Pick any quality profile on {instanceName} — including ones you created yourself. Its
          guide custom formats and current scores are listed so you can override any of them, and
          you can add more. Only the scores you set are changed; the rest of the profile is left
          alone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading quality profiles…
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No quality profiles found on this instance.</p>
        ) : (
          <>
            {/* Profile picker + always-visible managed profiles */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Select value={selectedProfile} onValueChange={selectProfile}>
                  <SelectTrigger className="w-72">
                    <SelectValue placeholder="Select a quality profile" />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map((p) => (
                      <SelectItem key={p.id} value={p.name} textValue={p.name}>
                        <span className="flex items-center gap-1.5">
                          {p.name}
                          {assignmentFor(p.name) && (
                            <ShieldCheck
                              className="h-3.5 w-3.5 shrink-0 text-green"
                              aria-label="managed"
                            />
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {currentProfile && (
                  <span className="text-xs text-muted-foreground">
                    {Object.keys(currentProfile.formatScores).length} custom format(s) currently scored
                  </span>
                )}
              </div>

              {managedProfileNames.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-xs text-muted-foreground">Managed:</span>
                  {managedProfileNames.map((name) => (
                    <Button
                      key={name}
                      variant={name === selectedProfile ? "secondary" : "outline"}
                      size="sm"
                      className="h-7"
                      onClick={() => selectProfile(name)}
                    >
                      <ShieldCheck className="mr-1 h-3.5 w-3.5 text-green" />
                      {name}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            {selectedProfile ? (
              <>
                {/* Two columns: assigned formats (left) · add formats (right). */}
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {/* LEFT — assigned formats, highest score first, each editable. */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs text-muted-foreground">
                        Assigned custom formats ({formats.length})
                      </Label>
                      {formats.length > 8 && (
                        <Input
                          placeholder="Filter…"
                          value={attachedQuery}
                          onChange={(e) => setAttachedQuery(e.target.value)}
                          className="h-8 w-40"
                        />
                      )}
                    </div>
                    {missingFormats.length > 0 && (
                      <div className="flex items-start gap-2 rounded-md border border-amber/30 bg-amber/5 px-2.5 py-2 text-[11px] text-amber">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="flex-1">
                          {missingFormats.length} format{missingFormats.length === 1 ? "" : "s"} below{" "}
                          {missingFormats.length === 1 ? "isn't" : "aren't"} in this app yet — the score
                          won&apos;t apply until the custom format exists.
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 shrink-0 border-amber/40 text-amber hover:text-amber"
                          onClick={() => addToAppAndApply(missingFormats)}
                          disabled={busy}
                          title="Add the missing custom formats to the app and apply their scores"
                        >
                          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-1 h-3.5 w-3.5" />}
                          Add all &amp; apply ({missingFormats.length})
                        </Button>
                      </div>
                    )}
                    <div className="h-[24rem] overflow-y-auto overflow-x-hidden rounded-md border border-white/5">
                      {formats.length === 0 ? (
                        <p className="p-4 text-center text-sm text-muted-foreground">
                          No custom formats assigned yet — add some from the right.
                        </p>
                      ) : (
                        <div className="divide-y divide-white/5">
                          {formats
                            .filter((f) => !attachedQuery || f.name.toLowerCase().includes(attachedQuery.toLowerCase()))
                            .map((f) => (
                              <div key={f.trashId} className="flex items-center gap-2 px-3 py-2">
                                <span className="min-w-0 flex-1 truncate text-sm">
                                  {f.name}
                                  {!isInApp(f.name) ? (
                                    <Badge
                                      variant="outline"
                                      className="ml-2 border-amber/40 text-[10px] text-amber"
                                      title="Not in this app yet — add & sync it from the Custom Formats tab"
                                    >
                                      not in app
                                    </Badge>
                                  ) : (
                                    f.score === 0 && (
                                      <span
                                        className="ml-2 text-[10px] text-muted-foreground"
                                        title="A score of 0 has no effect — set a score for this format to matter"
                                      >
                                        0 · no effect
                                      </span>
                                    )
                                  )}
                                </span>
                                <div className="flex shrink-0 items-center gap-1.5">
                                  {!isInApp(f.name) && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 border-amber/40 text-amber hover:text-amber"
                                      onClick={() => addToAppAndApply([f])}
                                      disabled={busy}
                                      title="Add this custom format to the app and apply its score"
                                    >
                                      <Plus className="mr-1 h-3.5 w-3.5" /> Add
                                    </Button>
                                  )}
                                  <Input
                                    type="number"
                                    value={Number.isFinite(f.score) ? f.score : 0}
                                    onChange={(e) => setScore(f.trashId, parseInt(e.target.value, 10) || 0)}
                                    className="h-8 w-24 text-right tabular-nums"
                                    title="Score"
                                  />
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8"
                                    onClick={() => removeFormat(f.trashId)}
                                    title="Remove"
                                  >
                                    <X className="h-4 w-4" />
                                  </Button>
                                </div>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* RIGHT — add formats, drill down by TRaSH category. */}
                  <div className="space-y-2">
                    <Label className="text-xs">Add a custom format — drill down by category</Label>
                    <Input
                      placeholder="Search all custom formats…"
                      value={cfQuery}
                      onChange={(e) => setCfQuery(e.target.value)}
                      className="h-8"
                    />
                    <div className="h-[24rem] overflow-y-auto overflow-x-hidden rounded-md border border-white/5">
                      {addableGroups.length === 0 || addableGroups.every((g) => g.items.length === 0) ? (
                        <p className="p-3 text-center text-xs text-muted-foreground">
                          No custom formats to add.
                        </p>
                      ) : (
                        <div className="divide-y divide-white/5">
                          {addableGroups.map((g) => (
                            <CategorySection
                              key={g.name}
                              name={g.name}
                              count={g.items.length}
                              expanded={isPickerOpen(g.name)}
                              onToggle={() => togglePicker(g.name)}
                            >
                              {g.items.map((cf) => (
                                <button
                                  key={cf.trashId}
                                  type="button"
                                  onClick={() => addFormat(cf)}
                                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 pl-8 text-left text-sm hover:bg-white/5"
                                >
                                  <span className="flex min-w-0 items-center gap-1.5">
                                    <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                    <span className="truncate">{cf.name}</span>
                                  </span>
                                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                                    default {cf.defaultScore}
                                  </span>
                                </button>
                              ))}
                            </CategorySection>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => runSync(true)} disabled={busy || formats.length === 0}>
                    <Eye className="mr-1 h-3.5 w-3.5" /> Preview diff
                  </Button>
                  <Button size="sm" onClick={save} disabled={busy}>
                    {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1 h-3.5 w-3.5" />}
                    Save
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => runSync(false)}
                    disabled={busy || !currentAssignment || isDirty}
                    title={
                      !currentAssignment
                        ? "Save first"
                        : isDirty
                          ? "Save your changes before syncing"
                          : "Apply scores to the profile"
                    }
                  >
                    <Play className="mr-1 h-3.5 w-3.5" /> Sync
                  </Button>
                  {isDirty && (
                    <span className="text-xs text-amber">Unsaved changes — Save to sync</span>
                  )}
                  {currentAssignment && (
                    <Button variant="outline" size="sm" onClick={unmanage} disabled={busy}>
                      Stop managing
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <p className="rounded-md border border-dashed border-white/10 p-6 text-center text-sm text-muted-foreground">
                Select a quality profile above to view and edit its custom-format scores.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Quality-profile options (score set + reset unmatched scores) ───

const GUIDE_DEFAULT_SCORE_SET = "__default__";

function QualityProfileOptionsDialog({
  item,
  scoreSets,
  busy,
  onClose,
  onSave,
}: {
  item: StatusItem | null;
  scoreSets: string[];
  busy: boolean;
  onClose: () => void;
  onSave: (selection: QualityProfileSelection) => void;
}) {
  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        {item && (
          <OptionsForm
            key={item.trashId}
            item={item}
            scoreSets={scoreSets}
            busy={busy}
            onCancel={onClose}
            onSave={onSave}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function OptionsForm({
  item,
  scoreSets,
  busy,
  onCancel,
  onSave,
}: {
  item: StatusItem;
  scoreSets: string[];
  busy: boolean;
  onCancel: () => void;
  onSave: (selection: QualityProfileSelection) => void;
}) {
  const initial = (item.selection ?? null) as QualityProfileSelection | null;
  const [scoreSet, setScoreSet] = useState<string>(initial?.scoreSet ?? GUIDE_DEFAULT_SCORE_SET);
  const [reset, setReset] = useState<boolean>(initial?.resetUnmatchedScores ?? false);
  const [exceptNames, setExceptNames] = useState<string>((initial?.resetExcept ?? []).join("\n"));
  const [exceptPatterns, setExceptPatterns] = useState<string>(
    (initial?.resetExceptPatterns ?? []).join("\n"),
  );

  const parseLines = (text: string) =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

  const submit = () => {
    const selection: QualityProfileSelection = {};
    if (scoreSet && scoreSet !== GUIDE_DEFAULT_SCORE_SET) selection.scoreSet = scoreSet;
    if (reset) {
      selection.resetUnmatchedScores = true;
      const names = parseLines(exceptNames);
      const patterns = parseLines(exceptPatterns);
      if (names.length) selection.resetExcept = names;
      if (patterns.length) selection.resetExceptPatterns = patterns;
    }
    onSave(selection);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Profile options — {item.name}</DialogTitle>
        <DialogDescription>
          Fine-tune how this quality profile is synced. Changes are recorded now and applied on the
          next sync.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5 py-1">
        <div className="space-y-1.5">
          <Label className="text-xs">Score set</Label>
          <Select value={scoreSet} onValueChange={setScoreSet}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={GUIDE_DEFAULT_SCORE_SET}>Guide default</SelectItem>
              {scoreSets.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            Which named custom-format score set to use (e.g. an SQP set). Leave on{" "}
            <span className="font-medium">Guide default</span> to use the profile&apos;s own score
            set.
          </p>
        </div>

        <div className="flex items-start justify-between gap-3 rounded-md border border-white/5 p-3">
          <div className="min-w-0">
            <Label className="text-sm">Reset unmatched scores</Label>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Reset every custom-format score this profile doesn&apos;t manage back to 0. Off by
              default, so scores you set elsewhere are preserved.
            </p>
          </div>
          <Switch checked={reset} onCheckedChange={setReset} className="mt-0.5 shrink-0" />
        </div>

        {reset && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Keep these formats (exact names)</Label>
              <textarea
                value={exceptNames}
                onChange={(e) => setExceptNames(e.target.value)}
                placeholder="One custom-format name per line"
                rows={3}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Keep these formats (regex patterns)</Label>
              <textarea
                value={exceptPatterns}
                onChange={(e) => setExceptPatterns(e.target.value)}
                placeholder="One regular expression per line (case-insensitive)"
                rows={3}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <p className="text-[11px] text-muted-foreground">
                A custom format matching any pattern is left untouched by the reset.
              </p>
            </div>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={busy}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-1.5 h-4 w-4" />}
          Save options
        </Button>
      </DialogFooter>
    </>
  );
}

// ─── Report / diff body ───

function ReportBody({ items, dryRun }: { items: PlanItem[]; dryRun: boolean }) {
  // A dry run hides items that are truly in sync (NOOP), but KEEPS a NOOP item
  // that carries a warning — e.g. "custom format not present — add & sync it
  // first". Otherwise the user sees "no diff" with no explanation of why.
  const visible = dryRun
    ? items.filter((i) => i.action !== "NOOP" || i.warnings.length > 0)
    : items;
  const hiddenInSync = items.length - visible.length;

  if (visible.length === 0) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        {items.length === 0 ? "Nothing to sync." : "No changes — everything is already in sync."}
      </p>
    );
  }
  return (
    <ScrollArea className="max-h-[24rem]">
      <div className="space-y-4 pr-2">
        {visible.map((item) => {
          const meta = ACTION_META[item.action];
          return (
            <div key={`${item.resourceType}:${item.trashId}`} className="rounded-md border border-white/5 p-3">
              <div className="mb-2 flex items-center gap-2">
                {item.action === "ERROR" ? (
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                ) : item.applied ? (
                  <CheckCircle2 className="h-4 w-4 text-green" />
                ) : null}
                <span className="text-sm font-medium">{item.name}</span>
                <Badge variant="outline" className={cn("text-[10.5px]", meta.className)}>{meta.label}</Badge>
              </div>
              {item.error && <p className="text-xs text-destructive">{item.error}</p>}
              {item.warnings.map((w, idx) => (
                <p key={idx} className="text-xs text-amber">⚠ {w}</p>
              ))}
              {item.diff.length > 0 && (
                <div className="mt-2 space-y-1">
                  {item.diff.slice(0, 40).map((d, idx) => (
                    <div key={idx} className="font-mono text-[11px] leading-relaxed">
                      <span className="text-muted-foreground">{d.path}: </span>
                      {d.kind !== "added" && <span className="text-destructive line-through">{fmt(d.before)}</span>}
                      {d.kind === "changed" && <span className="text-muted-foreground"> → </span>}
                      {d.kind !== "removed" && <span className="text-green">{fmt(d.after)}</span>}
                    </div>
                  ))}
                  {item.diff.length > 40 && (
                    <p className="text-[11px] text-muted-foreground">
                      …and {item.diff.length - 40} more change(s)
                    </p>
                  )}
                </div>
              )}
              {item.diff.length === 0 && item.action === "NOOP" && item.warnings.length === 0 && (
                <p className="text-xs text-muted-foreground">Already up to date.</p>
              )}
            </div>
          );
        })}
        {dryRun && hiddenInSync > 0 && (
          <p className="text-xs text-muted-foreground">
            {hiddenInSync} item{hiddenInSync === 1 ? "" : "s"} already in sync (hidden).
          </p>
        )}
      </div>
    </ScrollArea>
  );
}
