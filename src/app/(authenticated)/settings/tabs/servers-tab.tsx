"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaServer, PlexServer, PlexConnection, AuthInfo, TestResult } from "../types";

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
        <Badge variant="secondary" className="bg-green-500/20 text-green-400">
          <CheckCircle className="mr-1 h-3 w-3" />
          Completed
        </Badge>
      );
    case "FAILED":
      return (
        <Badge variant="secondary" className="bg-red-500/20 text-red-400">
          <XCircle className="mr-1 h-3 w-3" />
          Failed
        </Badge>
      );
    case "RUNNING":
      return (
        <Badge variant="secondary" className="bg-blue-500/20 text-blue-400">
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          Running
        </Badge>
      );
    case "PENDING":
      return (
        <Badge variant="secondary" className="bg-amber-500/20 text-amber-400">
          <Clock className="mr-1 h-3 w-3" />
          Pending
        </Badge>
      );
    case "CANCELLED":
      return (
        <Badge variant="secondary" className="bg-amber-500/20 text-amber-400">
          <XCircle className="mr-1 h-3 w-3" />
          Cancelled
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary">
          <Clock className="mr-1 h-3 w-3" />
          {status}
        </Badge>
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
  serverId: string;
  libraryKey: string;
  libraryType: string;
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

  // ─── Setters ───
  setAddServerDialog: React.Dispatch<React.SetStateAction<AddServerDialogState | null>>;
  setAddServerForm: React.Dispatch<React.SetStateAction<AddServerFormState>>;
  setAddServerError: (value: string) => void;
  setAddServerTestResult: (value: TestResult | null) => void;
  onStartPlexOAuth: () => Promise<void>;
  onCancelPlexOAuth: () => void;
  setEditingServerId: (value: string | null) => void;
  setEditServerUrl: (value: string) => void;
  setEditServerAccessToken: (value: string) => void;
  setEditServerTlsSkip: (value: boolean) => void;
  setEditServerError: (value: string) => void;
  setPlexServers: (value: PlexServer[]) => void;
  setPurgeDialog: (value: PurgeDialogState | null) => void;
  setSyncPrompt: (value: SyncPromptState | null) => void;
  setRemoveServerDialog: (value: RemoveServerDialogState | null) => void;

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
  setAddServerDialog,
  setAddServerForm,
  setAddServerError,
  setAddServerTestResult,
  onStartPlexOAuth,
  onCancelPlexOAuth,
  setEditingServerId,
  setEditServerUrl,
  setEditServerAccessToken,
  setEditServerTlsSkip,
  setEditServerError,
  setPlexServers,
  setPurgeDialog,
  setSyncPrompt,
  setRemoveServerDialog,
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
}: ServersTabProps) {
  const getPlexConnectionsForServer = (server: MediaServer): PlexConnection[] => {
    if (!server.machineId) return [];
    const plex = plexServers.find((s) => s.clientIdentifier === server.machineId);
    return plex?.connections ?? [];
  };

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Media Servers</h2>
          <div className="flex items-center gap-2">
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
          </div>
        </div>

        {plexLinking && (
          <div className="flex items-center gap-2 rounded-lg border p-3 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Waiting for Plex authentication... A popup should have opened.</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={onCancelPlexOAuth}
            >
              Cancel
            </Button>
          </div>
        )}

        {servers.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Server className="mx-auto h-12 w-12 text-muted-foreground" />
              <p className="mt-4 text-muted-foreground">
                No media servers connected.
              </p>
              <p className="text-sm text-muted-foreground">
                Use the &ldquo;Add Server&rdquo; button above to connect Plex, Jellyfin, or Emby.
              </p>
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
                <Card key={server.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="flex items-center gap-2">
                          <Server className="h-5 w-5" />
                          {server.name}
                          <Badge variant="outline" className="text-xs font-normal">
                            {server.type === "PLEX" ? "Plex" : server.type === "JELLYFIN" ? "Jellyfin" : server.type === "EMBY" ? "Emby" : server.type}
                          </Badge>
                          {!server.enabled && (
                            <Badge variant="secondary" className="text-xs font-normal bg-amber-500/20 text-amber-400">
                              Disabled
                            </Badge>
                          )}
                          <Switch
                            checked={server.enabled}
                            onCheckedChange={(checked) => onToggleServerEnabled(server.id, checked)}
                          />
                        </CardTitle>
                        {isEditing ? (
                          <div className="mt-2 space-y-2">
                            <div>
                              <label className="text-xs text-muted-foreground">URL</label>
                              <Input
                                value={editServerUrl}
                                onChange={(e) => setEditServerUrl(e.target.value)}
                                className="text-sm font-mono"
                                placeholder="http://your-server:32400"
                              />
                              <p className="text-xs text-muted-foreground mt-1">Must include http:// or https://</p>
                            </div>
                            {server.type !== "PLEX" && (
                              <div>
                                <label className="text-xs text-muted-foreground">API Key</label>
                                <Input
                                  type="password"
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
                              <input
                                type="checkbox"
                                checked={editServerTlsSkip}
                                onChange={(e) => setEditServerTlsSkip(e.target.checked)}
                                className="mt-0.5 rounded border-muted-foreground"
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
                                disabled={editServerSaving || !editServerUrl}
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
                              <p className="text-xs text-red-400">{editServerError}</p>
                            )}
                          </div>
                        ) : (
                          <CardDescription className="flex items-center gap-1">
                            {server.url}
                            <button
                              type="button"
                              onClick={() => onStartEditServer(server)}
                              className="ml-1 text-muted-foreground hover:text-foreground"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          </CardDescription>
                        )}
                      </div>
                      {!isEditing && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm">
                              Actions
                              <ChevronDown className="ml-2 h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
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
                      <div className="space-y-2">
                        {server.libraries.map((lib) => (
                          <div key={lib.id} className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className={!lib.enabled ? "opacity-50" : ""}>
                                {lib.title} ({lib.type}){lib._count.mediaItems > 0 && ` — ${lib._count.mediaItems.toLocaleString()}`}
                              </Badge>
                            </div>
                            <Switch
                              checked={lib.enabled}
                              onCheckedChange={(checked) => onToggleLibrary(server.id, lib.key, checked)}
                            />
                          </div>
                        ))}
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
                          <p className="mt-2 text-xs text-red-400">
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

      {/* Purge library data dialog */}
      <AlertDialog
        open={!!purgeDialog?.open}
        onOpenChange={(open) => { if (!open) setPurgeDialog(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable Last {purgeDialog?.libraryType?.charAt(0)}{purgeDialog?.libraryType?.slice(1).toLowerCase()} Library</AlertDialogTitle>
            <AlertDialogDescription>
              This is the last enabled {purgeDialog?.libraryType?.toLowerCase()} library.
              Would you like to delete existing {purgeDialog?.libraryType?.toLowerCase()} data from the database?
              Existing data will remain searchable if kept.
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
              {addServerDialog.libraries?.map((lib) => (
                <label
                  key={lib.key}
                  className="flex items-center justify-between rounded-lg border px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors"
                >
                  <div>
                    <span className="text-sm font-medium">{lib.title}</span>
                    <span className="ml-2 text-xs text-muted-foreground">({lib.type})</span>
                  </div>
                  <Switch
                    checked={lib.enabled}
                    onCheckedChange={(checked) => {
                      setAddServerDialog((prev) => prev ? {
                        ...prev,
                        libraries: prev.libraries?.map((l) =>
                          l.key === lib.key ? { ...l, enabled: checked } : l
                        ),
                      } : null);
                    }}
                  />
                </label>
              ))}
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
                <Input
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
    </>
  );
}
