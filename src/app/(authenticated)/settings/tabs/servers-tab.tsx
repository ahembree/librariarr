"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ColorChip } from "@/components/color-chip";
import { ServerTypeChip } from "@/components/server-type-chip";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Server,
  RefreshCw,
  Loader2,
  Plus,
  CheckCircle,
  XCircle,
  Clock,
  Trash2,
  Save,
  Pencil,
  ShieldOff,
  ChevronDown,
  AlertCircle,
  Plug,
  Film,
  Tv,
  Music,
  History,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  MediaServer,
  PlexServer,
  PlexConnection,
  AuthInfo,
  TestResult,
  TracearrInstance,
  TracearrServerListState,
  TracearrServerStatus,
} from "../types";

// ─── Local helpers ───

function formatSyncEta(startedAt: string, processed: number, total: number): string | null {
  if (processed <= 0 || total <= 0) return null;
  const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000;
  if (elapsed < 5) return null;
  const rate = processed / elapsed;
  const remaining = Math.ceil((total - processed) / rate);
  if (remaining < 60) return `~${remaining}s left`;
  const mins = Math.ceil(remaining / 60);
  if (mins < 60) return `~${mins}m left`;
  const hrs = Math.floor(mins / 60);
  return `~${hrs}h ${mins % 60}m left`;
}

function SyncProgressBar({ job }: { job: MediaServer["syncJobs"][0] }) {
  const isPending = job.status === "PENDING";
  const progress = job.totalItems > 0
    ? Math.round((job.itemsProcessed / job.totalItems) * 100)
    : 0;
  const eta = !isPending ? formatSyncEta(job.startedAt, job.itemsProcessed, job.totalItems) : null;

  if (isPending) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-amber-400" />
          <span className="font-medium text-amber-300">Pending</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Waiting for another sync to finish...</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 text-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
          <span className="font-medium text-blue-300">Syncing</span>
        </div>
        {eta && <span className="text-xs text-muted-foreground">{eta}</span>}
      </div>

      {job.totalItems > 0 ? (
        <div className="mt-2">
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span>
              {job.currentLibrary && (
                <span className="text-foreground">{job.currentLibrary}</span>
              )}
            </span>
            <span>
              {job.itemsProcessed.toLocaleString()} / {job.totalItems.toLocaleString()} ({progress}%)
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-blue-500 transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      ) : job.currentLibrary ? (
        <p className="mt-1 text-xs text-muted-foreground">{job.currentLibrary}</p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">Starting...</p>
      )}
    </div>
  );
}

function formatDate(date: string | null) {
  if (!date) return "Never";
  return new Date(date).toLocaleString();
}

function getSyncStatusBadge(status: string) {
  switch (status) {
    case "COMPLETED":
      return (
        <ColorChip className="bg-green-500/20 text-green-400">
          <CheckCircle className="mr-1 h-3 w-3" />
          Completed
        </ColorChip>
      );
    case "FAILED":
      return (
        <ColorChip className="bg-red-500/20 text-destructive">
          <XCircle className="mr-1 h-3 w-3" />
          Failed
        </ColorChip>
      );
    case "RUNNING":
      return (
        <ColorChip className="bg-blue-500/20 text-blue-400">
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          Running
        </ColorChip>
      );
    case "PENDING":
      return (
        <ColorChip className="bg-amber-500/20 text-amber-400">
          <Clock className="mr-1 h-3 w-3" />
          Pending
        </ColorChip>
      );
    case "CANCELLED":
      return (
        <ColorChip className="bg-amber-500/20 text-amber-400">
          <XCircle className="mr-1 h-3 w-3" />
          Cancelled
        </ColorChip>
      );
    default:
      return (
        <ColorChip className="border-border text-muted-foreground">
          <Clock className="mr-1 h-3 w-3" />
          {status}
        </ColorChip>
      );
  }
}

// ─── Types ───

export interface AddServerDialogState {
  open: boolean;
  type: "JELLYFIN" | "EMBY";
  step: "details" | "libraries";
  serverId?: string;
  libraries?: { key: string; title: string; type: string; enabled: boolean }[];
}

export interface AddServerFormState {
  name: string;
  url: string;
  apiKey: string;
  tlsSkipVerify: boolean;
}

export interface PurgeDialogState {
  open: boolean;
  mode: "library" | "server";
  serverId: string;
  serverName?: string;
  libraryId?: string;
  libraryKey?: string;
  libraryType?: string;
  isLastOfType?: boolean;
}

export interface SyncPromptState {
  open: boolean;
  serverId: string;
  libraryKey: string;
}

export interface RemoveServerDialogState {
  open: boolean;
  serverId: string;
  serverName: string;
}

export interface ServerTestResult {
  serverId: string;
  ok: boolean;
  error?: string;
}

/**
 * Pending change to a server's watch-history source. Confirmed before it is
 * written because switching sources clears the server's stored `WatchHistory`
 * — the two sources disagree on event identity, so they cannot be interleaved.
 */
export interface WatchHistorySourceDialogState {
  open: boolean;
  serverId: string;
  serverName: string;
  /** null reverts the server to its own (native) history. */
  tracearrServerId: string | null;
  /** Plain-text name of the picked source, for the confirmation copy. */
  sourceLabel: string;
}

// ─── Watch history source ───

/** Radix rejects "" as a value, so Native needs a sentinel. */
const NATIVE_WATCH_SOURCE = "native";

const NATIVE_WATCH_SOURCE_LABEL = "Native (server history)";

/** One Tracearr server, flattened across every enabled instance. */
interface WatchSourceOption {
  instanceId: string;
  instanceName: string;
  server: TracearrServerStatus;
}

function watchSourceLabel(option: WatchSourceOption): string {
  return `${option.server.name} (${option.server.type}) on ${option.instanceName}`;
}

/**
 * Per-server picker for where watch history comes from: the media server's own
 * history, or one of the servers a Tracearr instance monitors.
 *
 * Renders nothing when there is no enabled Tracearr instance — the dropdown
 * would offer a single option — but stays visible for an already-linked server
 * even then, so a link made before the instance was disabled can still be
 * undone.
 */
function WatchHistorySourceSelect({
  server,
  instances,
  serverLists,
  saving,
  onSelect,
}: {
  server: MediaServer;
  instances: TracearrInstance[];
  serverLists: Record<string, TracearrServerListState>;
  saving: boolean;
  onSelect: (tracearrServerId: string | null, sourceLabel: string) => void;
}) {
  const linkedId = server.tracearrServerId ?? null;
  const enabledInstances = instances.filter((i) => i.enabled);
  if (enabledInstances.length === 0 && !linkedId) return null;

  const lists = enabledInstances.map((instance) => ({ instance, state: serverLists[instance.id] }));
  // A list that hasn't been requested yet (undefined) is still loading as far
  // as the dropdown is concerned — offering options before every instance has
  // answered would hide servers that are about to appear.
  const loading = lists.some(({ state }) => !state || state.loading);
  const errors = lists
    .filter(({ state }) => state?.error)
    .map(({ instance, state }) => `${instance.name}: ${state!.error}`);

  const options: WatchSourceOption[] = lists.flatMap(({ instance, state }) =>
    (state?.servers ?? []).map((s) => ({
      instanceId: instance.id,
      instanceName: instance.name,
      server: s,
    })),
  );
  const linked = linkedId ? options.find((o) => o.server.id === linkedId) ?? null : null;

  // With nothing to pick, a Select is dead UI — except when the server is
  // already linked, where "back to Native" is itself a real choice (and the
  // only escape hatch when the instance is unreachable).
  const hasChoices = options.length > 0 || !!linkedId;
  const value = linked ? linked.server.id : linkedId ?? NATIVE_WATCH_SOURCE;

  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center gap-2">
        <h4 className="text-sm font-medium">Watch history source</h4>
        {(loading || saving) && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      <Select
        value={value}
        disabled={loading || saving || !hasChoices}
        onValueChange={(next) => {
          if (next === value) return;
          if (next === NATIVE_WATCH_SOURCE) {
            onSelect(null, NATIVE_WATCH_SOURCE_LABEL);
            return;
          }
          const picked = options.find((o) => o.server.id === next);
          onSelect(next, picked ? watchSourceLabel(picked) : next);
        }}
      >
        <SelectTrigger className="w-full sm:w-[420px]">
          <SelectValue placeholder={NATIVE_WATCH_SOURCE_LABEL} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NATIVE_WATCH_SOURCE}>{NATIVE_WATCH_SOURCE_LABEL}</SelectItem>
          {/* The stored mapping is a bare Tracearr server id, so the id is the
              option value and the owning instance is only a group label. */}
          {lists.map(({ instance, state }) => {
            const servers = state?.servers ?? [];
            if (servers.length === 0) return null;
            return (
              <React.Fragment key={instance.id}>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>{instance.name}</SelectLabel>
                  {servers.map((s) => (
                    <SelectItem key={`${instance.id}:${s.id}`} value={s.id}>
                      <span className="truncate">{s.name}</span>
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {s.type}
                      </span>
                      {!s.online && <span className="text-xs text-amber-400">offline</span>}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </React.Fragment>
            );
          })}
          {/* A link whose server isn't in any list (instance disabled, offline,
              or the server removed from Tracearr) still needs an item, or the
              trigger falls back to the placeholder and reads as Native. */}
          {linkedId && !linked && (
            <>
              <SelectSeparator />
              <SelectItem value={linkedId}>
                <span className="truncate">Linked Tracearr server</span>
                {!loading && <span className="text-xs text-amber-400">unavailable</span>}
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      {errors.length > 0 ? (
        // Shown instead of silently offering a short list: "we couldn't ask
        // Tracearr" must not look like "Tracearr monitors nothing".
        <div className="mt-1.5 space-y-0.5">
          {errors.map((message) => (
            <p key={message} className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>Couldn&apos;t load Tracearr servers — {message}</span>
            </p>
          ))}
        </div>
      ) : !loading && options.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Tracearr isn&apos;t monitoring any servers yet.
        </p>
      ) : (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
          <History className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Linking a Tracearr server replaces this server&apos;s own play history with Tracearr&apos;s
            per-play events (completion, device, transcode decision).
          </span>
        </p>
      )}
    </div>
  );
}

export interface ServersTabProps {
  // Server data
  servers: MediaServer[];
  hasActiveSync: boolean;

  // Sync state
  syncingServer: string | null;

  // Test connection state
  testingServer: string | null;
  testResult: ServerTestResult | null;

  // Refresh libraries state
  refreshingLibraries: string | null;

  // Add server dialog state
  addServerDialog: AddServerDialogState | null;
  addServerForm: AddServerFormState;
  addServerSaving: boolean;
  addServerError: string;
  addServerTesting: boolean;
  addServerTestResult: TestResult | null;

  // Plex OAuth linking state
  plexLinking: boolean;
  authInfo: AuthInfo | null;

  // Server editing state
  editingServerId: string | null;
  editServerUrl: string;
  editServerExternalUrl: string;
  editServerAccessToken: string;
  editServerTlsSkip: boolean;
  editServerSaving: boolean;
  editServerError: string;
  plexServers: PlexServer[];
  loadingPlexConnections: boolean;

  // Purge dialog state
  purgeDialog: PurgeDialogState | null;
  purging: boolean;

  // Sync prompt state
  syncPrompt: SyncPromptState | null;

  // Remove server dialog state
  removeServerDialog: RemoveServerDialogState | null;
  removingServer: boolean;

  // Watch history source (Tracearr mapping) state
  tracearrInstances: TracearrInstance[];
  /** Keyed by Tracearr instance id; absent until that instance's list is requested. */
  tracearrServerLists: Record<string, TracearrServerListState>;
  watchHistorySourceDialog: WatchHistorySourceDialogState | null;
  savingWatchHistorySource: string | null;

  // ─── Setters ───
  setAddServerDialog: React.Dispatch<React.SetStateAction<AddServerDialogState | null>>;
  setAddServerForm: React.Dispatch<React.SetStateAction<AddServerFormState>>;
  setAddServerError: (value: string) => void;
  setAddServerTestResult: (value: TestResult | null) => void;
  onStartPlexOAuth: () => Promise<void>;
  onCancelPlexOAuth: () => void;
  setEditingServerId: (value: string | null) => void;
  setEditServerUrl: (value: string) => void;
  setEditServerExternalUrl: (value: string) => void;
  setEditServerAccessToken: (value: string) => void;
  setEditServerTlsSkip: (value: boolean) => void;
  setEditServerError: (value: string) => void;
  setPlexServers: (value: PlexServer[]) => void;
  setPurgeDialog: (value: PurgeDialogState | null) => void;
  setSyncPrompt: (value: SyncPromptState | null) => void;
  setRemoveServerDialog: (value: RemoveServerDialogState | null) => void;
  setWatchHistorySourceDialog: (value: WatchHistorySourceDialogState | null) => void;

  // ─── Handlers ───
  onSyncServer: (serverId: string, libraryKey?: string) => void;
  onSyncAllServers: () => void;
  onTestServerConnection: (serverId: string) => void;
  onRemoveServer: (deleteData: boolean) => void;
  onStartEditServer: (server: MediaServer) => void;
  onSaveServer: (serverId: string) => void;
  onToggleLibrary: (serverId: string, libraryKey: string, enabled: boolean) => void;
  onRefreshLibraries: (serverId: string) => void;
  onHandlePurgeConfirm: (deleteData: boolean) => void;
  onTestAddServerConnection: () => void;
  onAddJellyfinEmbyServer: () => void;
  onConfirmAddServerLibraries: () => void;
  onToggleServerEnabled: (serverId: string, enabled: boolean) => void;
  onConfirmWatchHistorySource: () => void;
}

// ─── Component ───

export function ServersTab({
  servers,
  hasActiveSync,
  syncingServer,
  testingServer,
  testResult,
  refreshingLibraries,
  addServerDialog,
  addServerForm,
  addServerSaving,
  addServerError,
  addServerTesting,
  addServerTestResult,
  plexLinking,
  authInfo,
  editingServerId,
  editServerUrl,
  editServerExternalUrl,
  editServerAccessToken,
  editServerTlsSkip,
  editServerSaving,
  editServerError,
  plexServers,
  loadingPlexConnections,
  purgeDialog,
  purging,
  syncPrompt,
  removeServerDialog,
  removingServer,
  tracearrInstances,
  tracearrServerLists,
  watchHistorySourceDialog,
  savingWatchHistorySource,
  setAddServerDialog,
  setAddServerForm,
  setAddServerError,
  setAddServerTestResult,
  onStartPlexOAuth,
  onCancelPlexOAuth,
  setEditingServerId,
  setEditServerUrl,
  setEditServerExternalUrl,
  setEditServerAccessToken,
  setEditServerTlsSkip,
  setEditServerError,
  setPlexServers,
  setPurgeDialog,
  setSyncPrompt,
  setRemoveServerDialog,
  setWatchHistorySourceDialog,
  onSyncServer,
  onSyncAllServers,
  onTestServerConnection,
  onRemoveServer,
  onStartEditServer,
  onSaveServer,
  onToggleLibrary,
  onRefreshLibraries,
  onHandlePurgeConfirm,
  onTestAddServerConnection,
  onAddJellyfinEmbyServer,
  onConfirmAddServerLibraries,
  onToggleServerEnabled,
  onConfirmWatchHistorySource,
}: ServersTabProps) {
  const getPlexConnectionsForServer = (server: MediaServer): PlexConnection[] => {
    if (!server.machineId) return [];
    const plex = plexServers.find((s) => s.clientIdentifier === server.machineId);
    return plex?.connections ?? [];
  };

  const addServerMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add Server
          <ChevronDown className="ml-2 h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => {
          if (authInfo?.plexConnected) {
            window.location.href = "/onboarding";
            return;
          }
          onStartPlexOAuth();
        }}>
          Plex
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => {
          setAddServerDialog({ open: true, type: "JELLYFIN", step: "details" });
          setAddServerForm({ name: "", url: "", apiKey: "", tlsSkipVerify: false });
          setAddServerError("");
          setAddServerTestResult(null);
        }}>
          Jellyfin
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => {
          setAddServerDialog({ open: true, type: "EMBY", step: "details" });
          setAddServerForm({ name: "", url: "", apiKey: "", tlsSkipVerify: false });
          setAddServerError("");
          setAddServerTestResult(null);
        }}>
          Emby
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold">Media Servers</h2>
            <p className="text-sm text-muted-foreground">
              Connect Plex, Jellyfin, or Emby servers and manage which libraries are synced.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {servers.length > 1 && (
              <Button
                variant="outline"
                size="sm"
                onClick={onSyncAllServers}
                disabled={hasActiveSync}
              >
                {hasActiveSync ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Sync All
              </Button>
            )}
            {addServerMenu}
          </div>
        </div>

        {plexLinking && (
          <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
            <span className="flex-1">Waiting for Plex authentication... A popup should have opened.</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancelPlexOAuth}
            >
              Cancel
            </Button>
          </div>
        )}

        {servers.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <div className="rounded-full bg-muted p-4">
                <Server className="h-8 w-8 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="text-base font-medium">No media servers connected</p>
                <p className="text-sm text-muted-foreground">
                  Connect Plex, Jellyfin, or Emby to start syncing your libraries.
                </p>
              </div>
              <div className="mt-2">{addServerMenu}</div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {servers.map((server) => {
              const latestSync = server.syncJobs[0];
              const isSyncing = syncingServer === server.id;
              const isEditing = editingServerId === server.id;
              const connections = isEditing ? getPlexConnectionsForServer(server) : [];

              return (
                <Card key={server.id} className="overflow-hidden">
                  <CardHeader className="overflow-hidden pb-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="flex flex-wrap items-center gap-2">
                          <Server className="h-5 w-5 shrink-0" />
                          <span className="truncate">{server.name}</span>
                          <ServerTypeChip type={server.type} className="shrink-0" />
                          {!server.enabled && (
                            <ColorChip className="shrink-0 text-xs font-normal bg-amber-500/20 text-amber-400">
                              Disabled
                            </ColorChip>
                          )}
                          <Switch
                            className="shrink-0"
                            checked={server.enabled}
                            onCheckedChange={(checked) => onToggleServerEnabled(server.id, checked)}
                          />
                        </CardTitle>
                      </div>
                      {!isEditing && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" className="shrink-0">
                              Actions
                              <ChevronDown className="ml-2 h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => onStartEditServer(server)}
                            >
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => onTestServerConnection(server.id)}
                              disabled={testingServer === server.id}
                            >
                              {testingServer === server.id ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <Plug className="mr-2 h-4 w-4" />
                              )}
                              Test Connection
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => onSyncServer(server.id)}
                              disabled={isSyncing || hasActiveSync || !server.enabled}
                            >
                              {isSyncing ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCw className="mr-2 h-4 w-4" />
                              )}
                              Sync
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => setRemoveServerDialog({
                                open: true,
                                serverId: server.id,
                                serverName: server.name,
                              })}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className={cn(!server.enabled && "opacity-50")}>
                    {isEditing ? (
                      <div className="space-y-2 mb-4">
                        <div className="space-y-1.5">
                          <label className="text-xs text-muted-foreground">URL</label>
                          <Input
                            value={editServerUrl}
                            onChange={(e) => setEditServerUrl(e.target.value)}
                            className="text-sm font-mono"
                            placeholder="http://your-server:32400"
                          />
                          <p className="text-xs text-muted-foreground">Must include http:// or https://</p>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs text-muted-foreground">External URL</label>
                          <Input
                            value={editServerExternalUrl}
                            onChange={(e) => setEditServerExternalUrl(e.target.value)}
                            className={`text-sm font-mono ${editServerExternalUrl && !/^https?:\/\//i.test(editServerExternalUrl) ? "border-destructive" : ""}`}
                            placeholder="https://your-server.example.com (optional)"
                          />
                          <p className="text-xs text-muted-foreground">
                            {editServerExternalUrl && !/^https?:\/\//i.test(editServerExternalUrl)
                              ? "Must include http:// or https://"
                              : "Used for \u201cOpen in\u201d links. Falls back to URL above if empty."}
                          </p>
                        </div>
                        {server.type !== "PLEX" && (
                          <div className="space-y-1.5">
                            <label className="text-xs text-muted-foreground">API Key</label>
                            <SecretInput
                              value={editServerAccessToken}
                              onChange={(e) => setEditServerAccessToken(e.target.value)}
                              className="text-sm font-mono"
                              placeholder="Leave blank to keep current key"
                            />
                          </div>
                        )}
                        {loadingPlexConnections ? (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Loading known addresses...
                          </div>
                        ) : connections.length > 0 ? (
                          <div className="space-y-1">
                            <p className="text-xs text-muted-foreground">Known addresses:</p>
                            {connections.map((conn) => (
                              <button
                                key={conn.uri}
                                type="button"
                                onClick={() => setEditServerUrl(conn.uri)}
                                className={`block w-full rounded px-2 py-1 text-left text-xs transition-colors ${
                                  editServerUrl === conn.uri
                                    ? "bg-primary/10 text-primary"
                                    : "text-muted-foreground hover:bg-muted"
                                }`}
                              >
                                {conn.uri}
                                {conn.local && (
                                  <span className="ml-1 opacity-60">(local)</span>
                                )}
                              </button>
                            ))}
                          </div>
                        ) : null}
                        <label className="flex items-start gap-2 cursor-pointer pt-1">
                          <Checkbox
                            className="mt-0.5"
                            checked={editServerTlsSkip}
                            onCheckedChange={(v) => setEditServerTlsSkip(v === true)}
                          />
                          <div>
                            <span className="flex items-center gap-1 text-xs font-medium">
                              <ShieldOff className="h-3 w-3" />
                              Skip TLS Verification
                            </span>
                            <span className="text-xs text-muted-foreground">
                              Enable if using self-signed certificates
                            </span>
                          </div>
                        </label>
                        <div className="flex items-center gap-2 pt-1">
                          <Button
                            size="sm"
                            onClick={() => onSaveServer(server.id)}
                            disabled={editServerSaving || !editServerUrl || (!!editServerExternalUrl && !/^https?:\/\//i.test(editServerExternalUrl))}
                          >
                            {editServerSaving ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Save className="mr-2 h-4 w-4" />
                            )}
                            Save
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditingServerId(null);
                              setEditServerError("");
                              setPlexServers([]);
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                        {editServerError && (
                          <p className="text-xs text-destructive">{editServerError}</p>
                        )}
                      </div>
                    ) : (
                      <div className="mb-3 space-y-0.5">
                        <p className="text-sm font-mono text-muted-foreground truncate">{server.url}</p>
                        {(server as unknown as { externalUrl?: string | null }).externalUrl && (
                          <p className="text-xs text-muted-foreground truncate">
                            <span className="text-muted-foreground/60">External:</span>{" "}
                            <span className="font-mono">{(server as unknown as { externalUrl: string }).externalUrl}</span>
                          </p>
                        )}
                      </div>
                    )}
                    {testResult?.serverId === server.id && (
                      <div className={`mb-4 flex items-center gap-2 rounded-lg p-3 text-sm ${
                        testResult.ok
                          ? "bg-green-500/10 text-green-500"
                          : "bg-destructive/10 text-destructive"
                      }`}>
                        {testResult.ok ? (
                          <>
                            <CheckCircle className="h-4 w-4 shrink-0" />
                            Connection successful
                          </>
                        ) : (
                          <>
                            <XCircle className="h-4 w-4 shrink-0" />
                            Connection failed{testResult.error ? ` — ${testResult.error}` : ""}
                          </>
                        )}
                      </div>
                    )}
                    <WatchHistorySourceSelect
                      server={server}
                      instances={tracearrInstances}
                      serverLists={tracearrServerLists}
                      saving={savingWatchHistorySource === server.id}
                      onSelect={(tracearrServerId, sourceLabel) => setWatchHistorySourceDialog({
                        open: true,
                        serverId: server.id,
                        serverName: server.name,
                        tracearrServerId,
                        sourceLabel,
                      })}
                    />
                    <div className="mb-4">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-sm font-medium">Libraries</h4>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => onRefreshLibraries(server.id)}
                          disabled={refreshingLibraries === server.id}
                        >
                          <RefreshCw className={cn("mr-1 h-3 w-3", refreshingLibraries === server.id && "animate-spin")} />
                          Refresh
                        </Button>
                      </div>
                      <div className="space-y-1">
                        {server.libraries.map((lib) => {
                          const TypeIcon = lib.type === "MOVIE" ? Film : lib.type === "SERIES" ? Tv : Music;
                          return (
                            <div key={lib.id} className={`flex items-center gap-3 rounded-lg px-3 py-2 transition-colors ${lib.enabled ? "bg-muted/30" : "opacity-50"}`}>
                              <Switch
                                checked={lib.enabled}
                                onCheckedChange={(checked) => onToggleLibrary(server.id, lib.key, checked)}
                                size="sm"
                              />
                              <TypeIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <div className="flex-1 min-w-0">
                                <span className="text-sm font-medium">{lib.title}</span>
                                {lib._count.mediaItems > 0 && (
                                  <span className="ml-2 text-xs text-muted-foreground">{lib._count.mediaItems.toLocaleString()} items</span>
                                )}
                              </div>
                              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{lib.type}</span>
                            </div>
                          );
                        })}
                        {server.libraries.length === 0 && (
                          <p className="text-sm text-muted-foreground">
                            No libraries synced yet
                          </p>
                        )}
                      </div>
                    </div>

                    {latestSync && (latestSync.status === "RUNNING" || latestSync.status === "PENDING") ? (
                      <div className="space-y-2">
                        <SyncProgressBar job={latestSync} />
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={async () => {
                            try {
                              await fetch("/api/sync/cancel", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ serverId: server.id }),
                              });
                            } catch {
                              // Silent — status will update on next poll
                            }
                          }}
                        >
                          <XCircle className="mr-1.5 h-3.5 w-3.5" />
                          Stop Sync
                        </Button>
                      </div>
                    ) : latestSync ? (
                      <div className="rounded-lg bg-muted/50 p-3 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">
                            Last sync
                          </span>
                          {getSyncStatusBadge(latestSync.status)}
                        </div>
                        <div className="mt-1 flex items-center justify-between text-muted-foreground">
                          <span>{formatDate(latestSync.startedAt)}</span>
                          {latestSync.itemsProcessed > 0 && (
                            <span>
                              {latestSync.itemsProcessed} items
                            </span>
                          )}
                        </div>
                        {latestSync.error && (
                          <p className="mt-2 text-xs text-destructive">
                            {latestSync.error}
                          </p>
                        )}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Disable confirmation dialog (library or server) */}
      <AlertDialog
        open={!!purgeDialog?.open}
        onOpenChange={(open) => { if (!open) setPurgeDialog(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {purgeDialog?.mode === "server"
                ? `Disable ${purgeDialog.serverName}?`
                : purgeDialog?.isLastOfType
                  ? `Disable Last ${purgeDialog.libraryType?.charAt(0)}${purgeDialog.libraryType?.slice(1).toLowerCase()} Library`
                  : "Disable Library"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {purgeDialog?.mode === "server" ? (
                <>Would you like to also delete all synced media data from this server&apos;s libraries? This only removes database records — no actual media files will be affected.</>
              ) : (
                <>
                  {purgeDialog?.isLastOfType && (
                    <>This is the last enabled {purgeDialog.libraryType?.toLowerCase()} library.{" "}</>
                  )}
                  Would you like to also delete this library&apos;s media data from the database? This only removes database records — no actual media files will be affected.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={purging}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => onHandlePurgeConfirm(false)}
              disabled={purging}
              className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
            >
              Keep Data
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => onHandlePurgeConfirm(true)}
              disabled={purging}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {purging ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Delete Data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add Jellyfin/Emby server dialog */}
      <AlertDialog
        open={!!addServerDialog?.open}
        onOpenChange={(open) => { if (!open) setAddServerDialog(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {addServerDialog?.step === "libraries"
                ? "Select Libraries to Sync"
                : `Add ${addServerDialog?.type === "JELLYFIN" ? "Jellyfin" : "Emby"} Server`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {addServerDialog?.step === "libraries"
                ? "Choose which libraries to sync from this server."
                : "Enter your server details to connect."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {addServerDialog?.step === "libraries" ? (
            <div className="space-y-3 py-2">
              {addServerDialog.libraries?.map((lib) => {
                const TypeIcon = lib.type === "MOVIE" ? Film : lib.type === "SERIES" ? Tv : Music;
                return (
                  <label
                    key={lib.key}
                    className="flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <Switch
                      checked={lib.enabled}
                      size="sm"
                      onCheckedChange={(checked) => {
                        setAddServerDialog((prev) => prev ? {
                          ...prev,
                          libraries: prev.libraries?.map((l) =>
                            l.key === lib.key ? { ...l, enabled: checked } : l
                          ),
                        } : null);
                      }}
                    />
                    <TypeIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="text-sm font-medium flex-1">{lib.title}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{lib.type}</span>
                  </label>
                );
              })}
              {addServerDialog.libraries?.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No compatible libraries found on this server.
                </p>
              )}
              {addServerError && (
                <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {addServerError}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3 py-2">
              <div className="space-y-1">
                <Label htmlFor="add-server-url">URL</Label>
                <Input
                  id="add-server-url"
                  placeholder="http://your-server:8096"
                  value={addServerForm.url}
                  onChange={(e) => { setAddServerForm((f) => ({ ...f, url: e.target.value })); setAddServerTestResult(null); }}
                />
                <p className="text-xs text-muted-foreground">Must include http:// or https://</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="add-server-apikey">API Key</Label>
                <SecretInput
                  id="add-server-apikey"
                  placeholder="API key from dashboard"
                  value={addServerForm.apiKey}
                  onChange={(e) => { setAddServerForm((f) => ({ ...f, apiKey: e.target.value })); setAddServerTestResult(null); }}
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="add-server-tls"
                  checked={addServerForm.tlsSkipVerify}
                  onCheckedChange={(checked) => { setAddServerForm((f) => ({ ...f, tlsSkipVerify: checked })); setAddServerTestResult(null); }}
                />
                <Label htmlFor="add-server-tls" className="text-sm">Skip TLS verification</Label>
              </div>
              {addServerTestResult && (
                <div className={`flex items-center gap-2 rounded-md p-3 text-sm ${
                  addServerTestResult.ok
                    ? "bg-green-500/10 text-green-500"
                    : "bg-destructive/10 text-destructive"
                }`}>
                  {addServerTestResult.ok ? (
                    <>
                      <CheckCircle className="h-4 w-4 shrink-0" />
                      Connection successful
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 shrink-0" />
                      Connection failed{addServerTestResult.error ? ` — ${addServerTestResult.error}` : ""}
                    </>
                  )}
                </div>
              )}
              {addServerError && (
                <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {addServerError}
                </div>
              )}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={addServerSaving}>Cancel</AlertDialogCancel>
            {addServerDialog?.step === "libraries" ? (
              <Button
                onClick={onConfirmAddServerLibraries}
                disabled={addServerSaving}
              >
                {addServerSaving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle className="mr-2 h-4 w-4" />
                )}
                Confirm & Sync
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={onTestAddServerConnection}
                  disabled={addServerTesting || addServerSaving || !addServerForm.url || !addServerForm.apiKey}
                >
                  {addServerTesting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plug className="mr-2 h-4 w-4" />
                  )}
                  Test
                </Button>
                <Button
                  onClick={onAddJellyfinEmbyServer}
                  disabled={addServerSaving || !addServerForm.url || !addServerForm.apiKey || !addServerTestResult?.ok}
                >
                  {addServerSaving ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 h-4 w-4" />
                  )}
                  Add Server
                </Button>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Sync prompt after enabling library */}
      <AlertDialog
        open={!!syncPrompt?.open}
        onOpenChange={(open) => { if (!open) setSyncPrompt(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Library Enabled</AlertDialogTitle>
            <AlertDialogDescription>
              Would you like to sync this server now to fetch metadata for the newly enabled library?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (syncPrompt) onSyncServer(syncPrompt.serverId, syncPrompt.libraryKey);
                setSyncPrompt(null);
              }}
              disabled={!!syncingServer}
            >
              {syncingServer ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Sync Now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove server confirmation dialog */}
      <AlertDialog
        open={!!removeServerDialog?.open}
        onOpenChange={(open) => { if (!open) setRemoveServerDialog(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeServerDialog?.serverName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will disconnect the server. Would you also like to delete all synced library
              data (media items, metadata, and play history) from the database?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removingServer}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => onRemoveServer(false)}
              disabled={removingServer}
              className="bg-secondary text-secondary-foreground hover:bg-secondary/80"
            >
              Keep Data
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => onRemoveServer(true)}
              disabled={removingServer}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removingServer ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Delete Data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Watch history source change confirmation */}
      <AlertDialog
        open={!!watchHistorySourceDialog?.open}
        onOpenChange={(open) => { if (!open) setWatchHistorySourceDialog(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Change watch history source for {watchHistorySourceDialog?.serverName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              History will come from{" "}
              <span className="text-foreground">{watchHistorySourceDialog?.sourceLabel}</span>.
              Switching sources clears this server&apos;s stored watch history — the next sync
              repopulates it from the new source. Play counts and last-played dates will look empty
              until then, which affects any lifecycle rule that reads them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!savingWatchHistorySource}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onConfirmWatchHistorySource}
              disabled={!!savingWatchHistorySource}
            >
              {savingWatchHistorySource ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <History className="mr-2 h-4 w-4" />
              )}
              Change Source
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
