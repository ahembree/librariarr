"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  selection?: NamingSelection | null;
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

interface CatalogSummary {
  service: ServiceType;
  ref: string;
  fetchedAt: string;
  counts: { customFormats: number; qualityProfiles: number; qualitySize: number; naming: number };
  naming: TrashNaming | null;
  customFormats?: CatalogCf[];
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

// ─── Status presentation ───

const STATUS_META: Record<ItemStatus, { label: string; className: string }> = {
  NEW: { label: "Not added", className: "border-white/15 text-muted-foreground" },
  UNMANAGED_CONFLICT: { label: "Exists — unmanaged", className: "border-amber/40 text-amber" },
  MANAGED: { label: "Managed", className: "border-green/40 text-green" },
  MANAGED_OUTDATED: { label: "Update available", className: "border-blue-400/40 text-blue-400" },
  MANAGED_MISSING: { label: "Missing in app", className: "border-destructive/40 text-destructive" },
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

// ─── Page ───

export default function TrashSyncPage() {
  const [instances, setInstances] = useState<GuideInstance[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [status, setStatus] = useState<TrashStatus | null>(null);
  const [catalog, setCatalog] = useState<CatalogSummary | null>(null);
  const [loadingInstances, setLoadingInstances] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Dialog state
  const [confirmItem, setConfirmItem] = useState<StatusItem | null>(null);
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

  const loadStatus = useCallback(async (inst: GuideInstance, opts: { refresh?: boolean } = {}) => {
    setLoadingStatus(true);
    setStatus(null);
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
      setLoadingStatus(false);
    }
  }, []);

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
    await loadStatus(selected, { refresh: true });
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
      await loadStatus(selected);
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
      await loadStatus(selected);
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
        await loadStatus(selected);
        return;
      }
      const report: SyncReport = data.report;
      const errored = report.items.filter((i) => i.action === "ERROR").length;
      if (errored) toast.error(`Added “${item.name}” with errors`);
      else toast.success(`Added “${item.name}” to ${selected.name}`);
      setDiffReport({ title: `Add: ${item.name}`, items: report.items, dryRun: false });
      await loadStatus(selected);
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

  // Add every not-yet-existing resource of a type: assign them all, then create
  // them in the app. Only touches items with nothing to overwrite.
  const bulkAddNew = async (resourceType: ResourceType) => {
    if (!selected || !status) return;
    const toAdd = status.items.filter(
      (i) => i.resourceType === resourceType && i.status === "NEW",
    );
    if (!toAdd.length) return;
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
        toast.error("Failed to add");
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
        await loadStatus(selected);
        return;
      }
      const report: SyncReport = data.report;
      const errored = report.items.filter((i) => i.action === "ERROR").length;
      if (errored) toast.error(`Added ${toAdd.length} item(s) with ${errored} error(s)`);
      else toast.success(`Added ${toAdd.length} item${toAdd.length === 1 ? "" : "s"} to ${selected.name}`);
      setDiffReport({ title: `Add ${toAdd.length} item(s)`, items: report.items, dryRun: false });
      await loadStatus(selected);
    } finally {
      setSyncing(false);
    }
  };

  // ─── Preview / sync ───

  const preview = async (item?: StatusItem, selection?: NamingSelection) => {
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
      await loadStatus(selected);
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
      await loadStatus(selected);
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
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight flex items-center gap-2">
            <SlidersHorizontal className="h-7 w-7" />
            TRaSH Guide Sync
          </h1>
          <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
            Import recommended custom formats, quality profiles, quality sizes and naming schemes
            into your connected Sonarr / Radarr apps. Nothing is written to an app until you
            explicitly assign it to Librariarr — and you can preview every change first.
          </p>
        </div>
        {selected && (
          <Button variant="outline" size="sm" onClick={refreshGuides} disabled={refreshing || loadingStatus}>
            <RefreshCw className={cn("mr-1.5 h-4 w-4", refreshing && "animate-spin")} />
            Refresh guides
          </Button>
        )}
      </div>

      {/* Instance picker */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Target app</CardTitle>
          <CardDescription>
            Choose which connected Sonarr or Radarr instance to manage.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingInstances ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading integrations…
            </div>
          ) : instances.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No Sonarr or Radarr integrations found. Add one under{" "}
              <span className="font-medium text-foreground">Settings → Integrations</span> first.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Select value={selectedKey} onValueChange={setSelectedKey}>
                <SelectTrigger className="w-72">
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
                <span className="text-xs text-muted-foreground">
                  Guide {catalog.ref} · {catalog.counts.customFormats} formats ·{" "}
                  {catalog.counts.qualityProfiles} profiles
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

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
          {/* Summary + actions */}
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline" className="border-green/40 text-green">{counts.managed} managed</Badge>
                {counts.outdated > 0 && (
                  <Badge variant="outline" className="border-blue-400/40 text-blue-400">{counts.outdated} update{counts.outdated === 1 ? "" : "s"}</Badge>
                )}
                <Badge variant="outline" className="border-amber/40 text-amber">{counts.conflict} unmanaged</Badge>
                <Badge variant="outline">{counts.new} not added</Badge>
                {counts.missing > 0 && (
                  <Badge variant="outline" className="border-destructive/40 text-destructive">{counts.missing} missing</Badge>
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
            </CardContent>
          </Card>

          <Tabs defaultValue="cf">
            <TabsList>
              <TabsTrigger value="cf">Custom Formats ({cfItems.length})</TabsTrigger>
              <TabsTrigger value="qp">Quality Profiles ({qpItems.length})</TabsTrigger>
              <TabsTrigger value="profilecf">Profile Formats</TabsTrigger>
              <TabsTrigger value="misc">Sizes &amp; Naming</TabsTrigger>
            </TabsList>

            <TabsContent value="cf">
              <ResourceList
                items={cfItems}
                busyId={busyId}
                onManage={onManageClick}
                onPreview={(i) => preview(i)}
                onSync={(i) => syncOne(i)}
                onBulkAdd={() => bulkAddNew("CUSTOM_FORMAT")}
              />
            </TabsContent>

            <TabsContent value="qp">
              <ResourceList
                items={qpItems}
                busyId={busyId}
                onManage={onManageClick}
                onPreview={(i) => preview(i)}
                onSync={(i) => syncOne(i)}
                onBulkAdd={() => bulkAddNew("QUALITY_PROFILE")}
              />
            </TabsContent>

            <TabsContent value="profilecf">
              <ProfileFormatsTab
                key={`${selected.serviceType}:${selected.id}`}
                serviceType={selected.serviceType}
                instanceId={selected.id}
                instanceName={selected.name}
                catalogCfs={catalog?.customFormats ?? []}
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
          <ReportBody items={diffReport?.items ?? []} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiffReport(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Resource list (custom formats / quality profiles) ───

function ResourceList({
  items,
  busyId,
  onManage,
  onPreview,
  onSync,
  onBulkAdd,
}: {
  items: StatusItem[];
  busyId: string | null;
  onManage: (item: StatusItem) => void;
  onPreview: (item: StatusItem) => void;
  onSync: (item: StatusItem) => void;
  onBulkAdd: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "managed" | "unmanaged" | "new">("all");

  const filtered = items.filter((i) => {
    if (query && !i.name.toLowerCase().includes(query.toLowerCase())) return false;
    if (filter === "managed") return i.managed;
    if (filter === "unmanaged") return i.status === "UNMANAGED_CONFLICT";
    if (filter === "new") return i.status === "NEW";
    return true;
  });
  const newCount = items.filter((i) => i.status === "NEW").length;

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 w-56"
          />
          <Select value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <SelectTrigger className="h-9 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="managed">Managed</SelectItem>
              <SelectItem value="unmanaged">Unmanaged (exists)</SelectItem>
              <SelectItem value="new">Not added</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto">
            <Button variant="outline" size="sm" onClick={onBulkAdd} disabled={newCount === 0}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add all not-added ({newCount})
            </Button>
          </div>
        </div>

        {/* Native vertical scroll (not shadcn ScrollArea): its inner
            display:table wrapper lets long rows grow horizontally, which pushed
            the action buttons off-screen. overflow-x-hidden keeps rows bounded
            so the description truncates and the buttons stay visible. */}
        <div className="max-h-[26rem] overflow-y-auto overflow-x-hidden rounded-md border border-white/5">
          <div className="divide-y divide-white/5">
            {filtered.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">No items match.</p>
            ) : (
              filtered.map((item) => (
                <ResourceRow
                  key={item.trashId}
                  item={item}
                  busy={busyId === item.trashId}
                  onManage={() => onManage(item)}
                  onPreview={() => onPreview(item)}
                  onSync={() => onSync(item)}
                />
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ResourceRow({
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
    <div className="flex items-center gap-2 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{item.name}</span>
          <Badge variant="outline" className={cn("shrink-0 text-[10.5px]", meta.className)}>
            {meta.label}
          </Badge>
        </div>
        {item.description && (
          <p className="truncate text-xs text-muted-foreground">{item.description}</p>
        )}
      </div>
      {/* Actions never shrink, so a long description can't push them off-row. */}
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onPreview} disabled={busy}>
          <Eye className="mr-1 h-3.5 w-3.5" /> Diff
        </Button>
        {item.managed && (
          <Button variant="secondary" size="sm" onClick={onSync} disabled={busy} title="Sync just this item">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
            Sync
          </Button>
        )}
        <Button
          variant={item.managed ? "outline" : "default"}
          size="sm"
          onClick={onManage}
          disabled={busy}
          className="w-28"
          title={
            item.managed
              ? "Stop managing (leaves the app unchanged)"
              : item.existsInArr
                ? "Take over management — the next sync overwrites the app copy"
                : "Add this to the app now"
          }
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : item.managed ? (
            <>
              <X className="mr-1 h-3.5 w-3.5" /> Unmanage
            </>
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
  const [sel, setSel] = useState<NamingSelection>(item.selection ?? {});
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

function ProfileFormatsTab({
  serviceType,
  instanceId,
  instanceName,
  catalogCfs,
  onShowReport,
}: {
  serviceType: ServiceType;
  instanceId: string;
  instanceName: string;
  catalogCfs: CatalogCf[];
  onShowReport: (title: string, items: PlanItem[], dryRun: boolean) => void;
}) {
  const [profiles, setProfiles] = useState<ArrProfile[]>([]);
  const [assignments, setAssignments] = useState<ProfileCfAssignment[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string>("");
  const [formats, setFormats] = useState<ProfileCfFormat[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [cfQuery, setCfQuery] = useState("");
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

  // Guide custom formats keyed by lowercased name (to map a profile's current
  // scores — which are keyed by name — back to guide trash_ids).
  const cfByName = useMemo(() => {
    const m = new Map<string, CatalogCf>();
    for (const cf of catalogCfs) m.set(cf.name.toLowerCase(), cf);
    return m;
  }, [catalogCfs]);

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
    setFormats([...byTrashId.values()].sort((a, b) => a.name.localeCompare(b.name)));
  };

  const addFormat = (cf: CatalogCf) => {
    if (formats.some((f) => f.trashId === cf.trashId)) return;
    setFormats((prev) => [...prev, { trashId: cf.trashId, name: cf.name, score: cf.defaultScore }]);
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

  const attachedIds = new Set(formats.map((f) => f.trashId));
  const cfMatches = catalogCfs
    .filter((cf) => !attachedIds.has(cf.trashId))
    .filter((cf) => !cfQuery || cf.name.toLowerCase().includes(cfQuery.toLowerCase()))
    .slice(0, 60);

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
            <div className="flex flex-wrap items-center gap-2">
              <Select value={selectedProfile} onValueChange={selectProfile}>
                <SelectTrigger className="w-72">
                  <SelectValue placeholder="Select a quality profile" />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.name}>
                      {p.name}
                      {assignmentFor(p.name) ? " · managed" : ""}
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

            {selectedProfile && (
              <>
                {/* Attached formats — every guide custom format scored on the
                    profile, each with an editable (override) score. */}
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs text-muted-foreground">
                    Assigned custom formats ({formats.length})
                  </Label>
                  {formats.length > 8 && (
                    <Input
                      placeholder="Filter…"
                      value={attachedQuery}
                      onChange={(e) => setAttachedQuery(e.target.value)}
                      className="h-8 w-48"
                    />
                  )}
                </div>
                <div className="max-h-72 overflow-y-auto overflow-x-hidden rounded-md border border-white/5">
                  {formats.length === 0 ? (
                    <p className="p-4 text-center text-sm text-muted-foreground">
                      No custom formats assigned yet — add some below.
                    </p>
                  ) : (
                    <div className="divide-y divide-white/5">
                      {formats
                        .filter((f) => !attachedQuery || f.name.toLowerCase().includes(attachedQuery.toLowerCase()))
                        .map((f) => (
                          <div key={f.trashId} className="flex items-center gap-3 px-3 py-2">
                            <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <Label className="text-xs text-muted-foreground">Score</Label>
                              <Input
                                type="number"
                                value={Number.isFinite(f.score) ? f.score : 0}
                                onChange={(e) => setScore(f.trashId, parseInt(e.target.value, 10) || 0)}
                                className="h-8 w-24"
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

                {/* Add custom formats */}
                <div className="space-y-2">
                  <Label className="text-xs">Add a custom format</Label>
                  <Input
                    placeholder="Search custom formats…"
                    value={cfQuery}
                    onChange={(e) => setCfQuery(e.target.value)}
                    className="h-9"
                  />
                  {cfQuery && (
                    <div className="max-h-48 overflow-y-auto overflow-x-hidden rounded-md border border-white/5">
                      {cfMatches.length === 0 ? (
                        <p className="p-3 text-center text-xs text-muted-foreground">No matches.</p>
                      ) : (
                        cfMatches.map((cf) => (
                          <button
                            key={cf.trashId}
                            type="button"
                            onClick={() => addFormat(cf)}
                            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-white/5"
                          >
                            <span className="truncate">{cf.name}</span>
                            <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                              default {cf.defaultScore}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
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
                    disabled={busy || !currentAssignment}
                    title={currentAssignment ? "Apply scores to the profile" : "Save first"}
                  >
                    <Play className="mr-1 h-3.5 w-3.5" /> Sync
                  </Button>
                  {currentAssignment && (
                    <Button variant="outline" size="sm" onClick={unmanage} disabled={busy}>
                      Stop managing
                    </Button>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Report / diff body ───

function ReportBody({ items }: { items: PlanItem[] }) {
  if (items.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">Nothing to sync.</p>;
  }
  return (
    <ScrollArea className="max-h-[24rem]">
      <div className="space-y-4 pr-2">
        {items.map((item) => {
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
              {item.diff.length === 0 && item.action === "NOOP" && (
                <p className="text-xs text-muted-foreground">Already up to date.</p>
              )}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
