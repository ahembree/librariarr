"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Server, Loader2, Check, AlertCircle, Pencil, ShieldOff, ArrowLeft, Plug, CheckCircle, XCircle } from "lucide-react";
import { Logo } from "@/components/logo";
import { usePlexOAuth } from "@/hooks/use-plex-oauth";
import { SERVER_TYPE_STYLES } from "@/lib/server-styles";

// ─── Types ───

interface PlexConnection {
  protocol: string;
  address: string;
  port: number;
  uri: string;
  local: boolean;
}

interface PlexServer {
  name: string;
  clientIdentifier: string;
  product: string;
  productVersion: string;
  platform: string;
  accessToken: string;
  connections: PlexConnection[];
}

interface DiscoveredLibrary {
  key: string;
  title: string;
  type: string;
  enabled: boolean;
  exists: boolean;
}

type OnboardingMode = "choose" | "plex" | "manual";
type ManualServerType = "JELLYFIN" | "EMBY";

// Server type config for the chooser cards (derived from centralized styles)
const SERVER_TYPES = [
  { type: "PLEX" as const, label: "Plex", description: "Auto-discover servers from your Plex account", ...SERVER_TYPE_STYLES.PLEX.onboarding },
  { type: "JELLYFIN" as const, label: "Jellyfin", description: "Connect with your server URL and API key", ...SERVER_TYPE_STYLES.JELLYFIN.onboarding },
  { type: "EMBY" as const, label: "Emby", description: "Connect with your server URL and API key", ...SERVER_TYPE_STYLES.EMBY.onboarding },
] as const;

// Color config per manual server type (derived from centralized styles)
const MANUAL_COLORS: Record<ManualServerType, NonNullable<(typeof SERVER_TYPE_STYLES)[string]["manual"]>> = {
  JELLYFIN: SERVER_TYPE_STYLES.JELLYFIN.manual!,
  EMBY: SERVER_TYPE_STYLES.EMBY.manual!,
};

function getDefaultUrl(connections: PlexConnection[]): string {
  const remote = connections.find((c) => !c.local);
  return (remote || connections[0])?.uri ?? "";
}

export default function OnboardingPage() {
  const router = useRouter();

  // Mode & detection
  const [mode, setMode] = useState<OnboardingMode>("choose");
  const [loading, setLoading] = useState(true);
  const [hasPlexToken, setHasPlexToken] = useState(false);
  const [autoDetectedPlex, setAutoDetectedPlex] = useState(false);

  // Plex-specific state
  const [plexServers, setPlexServers] = useState<PlexServer[]>([]);
  const [addingServer, setAddingServer] = useState<string | null>(null);
  const [addedServers, setAddedServers] = useState<Set<string>>(new Set());
  const [editingServer, setEditingServer] = useState<string | null>(null);
  const [customUrls, setCustomUrls] = useState<Record<string, string>>({});
  const [tlsSkipVerify, setTlsSkipVerify] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Shared library selection state
  const [selectingLibraries, setSelectingLibraries] = useState<string | null>(null);
  const [serverIdMap, setServerIdMap] = useState<Record<string, string>>({});
  const [serverLibraries, setServerLibraries] = useState<Record<string, DiscoveredLibrary[]>>({});
  const [librarySelections, setLibrarySelections] = useState<Record<string, Record<string, boolean>>>({});
  const [savingLibraries, setSavingLibraries] = useState(false);

  // Manual server entry state (Jellyfin/Emby)
  const [manualType, setManualType] = useState<ManualServerType>("JELLYFIN");
  const [manualForm, setManualForm] = useState({ name: "", url: "", apiKey: "", tlsSkipVerify: false });
  const [manualTestResult, setManualTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [manualTesting, setManualTesting] = useState(false);
  const [manualAdding, setManualAdding] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualAdded, setManualAdded] = useState(false);
  const [manualServerId, setManualServerId] = useState<string | null>(null);
  const [manualSelectingLibs, setManualSelectingLibs] = useState(false);
  const [manualLibraries, setManualLibraries] = useState<DiscoveredLibrary[]>([]);
  const [manualLibSelections, setManualLibSelections] = useState<Record<string, boolean>>({});

  // ─── Plex OAuth (for users without a Plex token) ───

  const fetchPlexServers = useCallback(async () => {
    try {
      const [plexRes, existingRes] = await Promise.all([
        fetch("/api/auth/plex/servers"),
        fetch("/api/servers"),
      ]);
      if (!plexRes.ok) return;
      setHasPlexToken(true);
      const plexData = await plexRes.json();
      const existingData = await existingRes.json();
      const fetched: PlexServer[] = plexData.servers || [];
      setPlexServers(fetched);

      const urls: Record<string, string> = {};
      for (const s of fetched) urls[s.clientIdentifier] = getDefaultUrl(s.connections);
      setCustomUrls(urls);

      const existingMachineIds = new Set(
        (existingData.servers || []).map((s: { machineId: string }) => s.machineId)
      );
      const alreadyAdded = new Set<string>();
      for (const s of fetched) {
        if (existingMachineIds.has(s.clientIdentifier)) alreadyAdded.add(s.clientIdentifier);
      }
      if (alreadyAdded.size > 0) setAddedServers(alreadyAdded);

      setMode("plex");
    } catch {
      // Network error
    }
  }, []);

  const { startAuth: startPlexAuth, isLoading: plexAuthLoading, error: plexAuthError, authUrl: plexAuthUrl } = usePlexOAuth({
    onSuccess: async (authToken) => {
      // Link the Plex account to the current (local) user
      const res = await fetch("/api/auth/plex/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authToken }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Failed to link Plex account");
      if (!result.linked) throw new Error(result.message || "Plex authentication not completed");
      // Now fetch Plex servers with the new token
      await fetchPlexServers();
    },
  });

  // ─── Mount: detect Plex token ───

  useEffect(() => {
    async function detect() {
      try {
        await fetchPlexServers();
        // If fetchPlexServers succeeded, it set mode to "plex"
        // Mark as auto-detected so we don't show a back button
        setAutoDetectedPlex(true);
      } catch {
        // No Plex token or network error → stay on "choose"
      } finally {
        setLoading(false);
      }
    }
    detect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Plex server handlers ───

  const addPlexServer = async (server: PlexServer) => {
    setAddingServer(server.clientIdentifier);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[server.clientIdentifier];
      return next;
    });

    const url = customUrls[server.clientIdentifier] || getDefaultUrl(server.connections);

    try {
      const response = await fetch("/api/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: server.name,
          url,
          accessToken: server.accessToken,
          machineId: server.clientIdentifier,
          tlsSkipVerify: !!tlsSkipVerify[server.clientIdentifier],
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        const message = data.detail ? `${data.error} — ${data.detail}` : data.error;
        setErrors((prev) => ({ ...prev, [server.clientIdentifier]: message }));
        setEditingServer(server.clientIdentifier);
        return;
      }

      if (data.updated) {
        setAddedServers((prev) => new Set(prev).add(server.clientIdentifier));
        setEditingServer(null);
        return;
      }

      setServerIdMap((prev) => ({ ...prev, [server.clientIdentifier]: data.server.id }));

      try {
        const libRes = await fetch(`/api/servers/${data.server.id}/libraries`);
        const libData = await libRes.json();
        const libs: DiscoveredLibrary[] = libData.libraries || [];

        setServerLibraries((prev) => ({ ...prev, [server.clientIdentifier]: libs }));
        const selections: Record<string, boolean> = {};
        for (const lib of libs) selections[lib.key] = true;
        setLibrarySelections((prev) => ({ ...prev, [server.clientIdentifier]: selections }));
        setSelectingLibraries(server.clientIdentifier);
      } catch {
        setAddedServers((prev) => new Set(prev).add(server.clientIdentifier));
        await fetch(`/api/servers/${data.server.id}/sync`, { method: "POST" });
      }

      setEditingServer(null);
    } catch {
      setErrors((prev) => ({
        ...prev,
        [server.clientIdentifier]: "Network error — could not reach Librariarr API",
      }));
    } finally {
      setAddingServer(null);
    }
  };

  const confirmLibrarySelection = async (clientIdentifier: string) => {
    setSavingLibraries(true);
    const serverId = serverIdMap[clientIdentifier];
    const selections = librarySelections[clientIdentifier] || {};
    const libs = serverLibraries[clientIdentifier] || [];

    try {
      await fetch(`/api/servers/${serverId}/libraries`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          libraries: libs.map((lib) => ({ key: lib.key, enabled: selections[lib.key] ?? true })),
        }),
      });
      await fetch(`/api/servers/${serverId}/sync`, { method: "POST" });
      setAddedServers((prev) => new Set(prev).add(clientIdentifier));
      setSelectingLibraries(null);
    } catch (error) {
      console.error("Failed to save library selection:", error);
    } finally {
      setSavingLibraries(false);
    }
  };

  const toggleLibrary = (clientIdentifier: string, key: string) => {
    setLibrarySelections((prev) => ({
      ...prev,
      [clientIdentifier]: { ...prev[clientIdentifier], [key]: !prev[clientIdentifier]?.[key] },
    }));
  };

  // ─── Manual server handlers (Jellyfin/Emby) ───

  const testManualConnection = useCallback(async () => {
    setManualTesting(true);
    setManualTestResult(null);
    try {
      const response = await fetch("/api/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: manualForm.name || `${manualType === "JELLYFIN" ? "Jellyfin" : "Emby"} Server`,
          url: manualForm.url,
          accessToken: manualForm.apiKey,
          type: manualType,
          tlsSkipVerify: manualForm.tlsSkipVerify,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setManualTestResult({ ok: false, error: data.detail || data.error });
      } else {
        setManualTestResult({ ok: true });
        // Server was created — store its ID for library selection
        setManualServerId(data.server?.id || null);
      }
    } catch {
      setManualTestResult({ ok: false, error: "Network error — could not reach Librariarr API" });
    } finally {
      setManualTesting(false);
    }
  }, [manualForm, manualType]);

  const proceedToManualLibraries = useCallback(async () => {
    if (!manualServerId) return;
    setManualAdding(true);
    setManualError(null);
    try {
      const libRes = await fetch(`/api/servers/${manualServerId}/libraries`);
      const libData = await libRes.json();
      const libs: DiscoveredLibrary[] = libData.libraries || [];
      setManualLibraries(libs);
      const selections: Record<string, boolean> = {};
      for (const lib of libs) selections[lib.key] = true;
      setManualLibSelections(selections);
      setManualSelectingLibs(true);
    } catch {
      // If library fetch fails, just sync all
      await fetch(`/api/servers/${manualServerId}/sync`, { method: "POST" });
      setManualAdded(true);
    } finally {
      setManualAdding(false);
    }
  }, [manualServerId]);

  const confirmManualLibraries = useCallback(async () => {
    if (!manualServerId) return;
    setSavingLibraries(true);
    try {
      await fetch(`/api/servers/${manualServerId}/libraries`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          libraries: manualLibraries.map((lib) => ({ key: lib.key, enabled: manualLibSelections[lib.key] ?? true })),
        }),
      });
      await fetch(`/api/servers/${manualServerId}/sync`, { method: "POST" });
      setManualAdded(true);
      setManualSelectingLibs(false);
    } catch (error) {
      console.error("Failed to save library selection:", error);
    } finally {
      setSavingLibraries(false);
    }
  }, [manualServerId, manualLibraries, manualLibSelections]);

  // ─── Navigation helpers ───

  const handleChooseServerType = (type: "PLEX" | "JELLYFIN" | "EMBY") => {
    if (type === "PLEX") {
      if (hasPlexToken) {
        setMode("plex");
      } else {
        // No Plex token → initiate Plex OAuth to link account
        startPlexAuth();
      }
      return;
    }
    setManualType(type);
    setManualForm({ name: "", url: "", apiKey: "", tlsSkipVerify: false });
    setManualTestResult(null);
    setManualError(null);
    setManualAdded(false);
    setManualServerId(null);
    setManualSelectingLibs(false);
    setManualLibraries([]);
    setManualLibSelections({});
    setMode("manual");
  };

  const handleBack = () => {
    setMode("choose");
  };

  // ─── Loading state ───

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ─── Choose mode ───

  if (mode === "choose") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_center,oklch(0.22_0.02_270),oklch(0.14_0.006_270))] p-8">
        <div className="w-full max-w-3xl space-y-8">
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-24 w-24 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
              <Logo size={96} />
            </div>
            <h1 className="text-3xl font-bold font-display tracking-tight">Connect a Media Server</h1>
            <p className="mt-2 text-muted-foreground">
              Choose your media server type to get started.
            </p>
          </div>

          <div className="flex flex-wrap justify-center gap-4">
            {SERVER_TYPES.map((st) => {
              const isPlex = st.type === "PLEX";
              const isPlexLoading = isPlex && plexAuthLoading;

              return (
                <button
                  key={st.type}
                  type="button"
                  onClick={() => handleChooseServerType(st.type)}
                  disabled={isPlexLoading}
                  className={`group relative flex-1 min-w-56 max-w-xs rounded-xl border ${st.borderColor} ${st.bgColor} p-6 text-left transition-all cursor-pointer ${st.hoverBg}`}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${st.bgColor}`}>
                      {isPlexLoading ? (
                        <Loader2 className={`h-5 w-5 animate-spin ${st.iconColor}`} />
                      ) : (
                        <Server className={`h-5 w-5 ${st.iconColor}`} />
                      )}
                    </div>
                    <span className={`text-lg font-semibold ${st.iconColor}`}>{st.label}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {isPlexLoading ? "Waiting for Plex sign-in..." : st.description}
                  </p>
                  {isPlex && !hasPlexToken && !plexAuthLoading && (
                    <p className="mt-2 text-xs text-muted-foreground/70">
                      Opens Plex sign-in to link your account
                    </p>
                  )}
                </button>
              );
            })}
          </div>

          {plexAuthError && (
            <div className="mx-auto max-w-md flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <p>{plexAuthError}</p>
            </div>
          )}

          {plexAuthUrl && plexAuthLoading && (
            <p className="text-center text-sm text-muted-foreground">
              Popup blocked?{" "}
              <a href={plexAuthUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
                Click here to sign in with Plex
              </a>
            </p>
          )}

          <div className="text-center">
            <button
              type="button"
              onClick={() => router.push("/")}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Skip for now — I&apos;ll set this up later
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Plex mode ───

  if (mode === "plex") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_center,oklch(0.22_0.02_270),oklch(0.14_0.006_270))] p-8">
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-150 h-150 rounded-full bg-amber-500/5 blur-3xl" />
        </div>
        <div className="relative w-full max-w-5xl space-y-8">
          <div className="text-center">
            {!autoDetectedPlex && (
              <button
                type="button"
                onClick={handleBack}
                className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>
            )}
            <div className="mx-auto mb-4 flex h-24 w-24 items-center justify-center rounded-full bg-amber-500/15 ring-1 ring-amber-500/20">
              <Logo size={96} />
            </div>
            <h1 className="text-3xl font-bold font-display tracking-tight bg-linear-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">Select Your Plex Servers</h1>
            <p className="mt-2 text-muted-foreground">
              Choose which servers to connect. You can select which libraries to sync.
            </p>
          </div>

          {plexServers.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Server className="mx-auto h-12 w-12 text-muted-foreground" />
                <p className="mt-4 text-muted-foreground">
                  No Plex servers found on your account.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-wrap justify-center gap-4">
              {plexServers.map((server) => {
                const id = server.clientIdentifier;
                const isAdded = addedServers.has(id);
                const isAdding = addingServer === id;
                const isEditing = editingServer === id;
                const isSelectingLibs = selectingLibraries === id;
                const error = errors[id];
                const currentUrl = customUrls[id] || getDefaultUrl(server.connections);

                return (
                  <Card
                    key={id}
                    className={`max-w-sm flex-1 min-w-72 ${isAdded ? "border-amber-500/40" : error ? "border-destructive/50" : "border-amber-500/15"}`}
                  >
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Server className="h-5 w-5 text-amber-500" />
                        {server.name}
                      </CardTitle>
                      <CardDescription>
                        {server.platform} &middot; v{server.productVersion}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {isEditing ? (
                        <div className="space-y-2">
                          <Label htmlFor={`url-${id}`}>Server URL</Label>
                          <Input
                            id={`url-${id}`}
                            value={currentUrl}
                            onChange={(e) => setCustomUrls((prev) => ({ ...prev, [id]: e.target.value }))}
                            placeholder="http://your-server:32400"
                          />
                          {server.connections.length > 0 && (
                            <div className="space-y-1">
                              <p className="text-xs text-muted-foreground">Known addresses:</p>
                              {server.connections.map((conn) => (
                                <button
                                  key={conn.uri}
                                  type="button"
                                  onClick={() => setCustomUrls((prev) => ({ ...prev, [id]: conn.uri }))}
                                  className={`block w-full rounded px-2 py-1 text-left text-xs transition-colors ${
                                    currentUrl === conn.uri
                                      ? "bg-amber-500/10 text-amber-400"
                                      : "text-muted-foreground hover:bg-muted"
                                  }`}
                                >
                                  {conn.uri}
                                  {conn.local && <span className="ml-1 opacity-60">(local)</span>}
                                </button>
                              ))}
                            </div>
                          )}
                          <label className="flex items-start gap-2 cursor-pointer pt-1">
                            <input
                              type="checkbox"
                              checked={!!tlsSkipVerify[id]}
                              onChange={(e) => setTlsSkipVerify((prev) => ({ ...prev, [id]: e.target.checked }))}
                              className="mt-0.5 rounded border-muted-foreground"
                            />
                            <div>
                              <span className="flex items-center gap-1 text-xs font-medium">
                                <ShieldOff className="h-3 w-3" />
                                Skip TLS Verification
                              </span>
                              <span className="text-xs text-muted-foreground">
                                Enable if using self-signed certificates. For custom CAs, set NODE_EXTRA_CA_CERTS instead.
                              </span>
                            </div>
                          </label>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between rounded bg-muted/50 px-3 py-2">
                          <span className="truncate text-xs text-muted-foreground font-mono">{currentUrl}</span>
                          {!isAdded && !isSelectingLibs && (
                            <button
                              type="button"
                              onClick={() => setEditingServer(id)}
                              className="ml-2 shrink-0 text-muted-foreground hover:text-foreground"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      )}

                      {error && (
                        <div className="flex gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                          <p>{error}</p>
                        </div>
                      )}

                      {isSelectingLibs && (
                        <div className="space-y-3">
                          <div>
                            <h4 className="text-sm font-medium mb-2">Select Libraries to Sync</h4>
                            <div className="space-y-2">
                              {(serverLibraries[id] || []).map((lib) => (
                                <label
                                  key={lib.key}
                                  className="flex items-center justify-between rounded-lg border px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors"
                                >
                                  <div>
                                    <span className="text-sm font-medium">{lib.title}</span>
                                    <span className="ml-2 text-xs text-muted-foreground">({lib.type})</span>
                                  </div>
                                  <Switch
                                    checked={librarySelections[id]?.[lib.key] ?? true}
                                    onCheckedChange={() => toggleLibrary(id, lib.key)}
                                  />
                                </label>
                              ))}
                            </div>
                          </div>
                          <Button
                            onClick={() => confirmLibrarySelection(id)}
                            disabled={savingLibraries}
                            className="w-full bg-amber-500 text-black hover:bg-amber-600"
                          >
                            {savingLibraries && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Confirm & Sync
                          </Button>
                        </div>
                      )}

                      {!isSelectingLibs && (
                        <Button
                          onClick={() => addPlexServer(server)}
                          disabled={isAdding || isAdded}
                          className={`w-full ${isAdded ? "bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20" : "bg-amber-500 text-black hover:bg-amber-600"}`}
                          variant={isAdded ? "secondary" : "default"}
                        >
                          {isAdding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                          {isAdded && <Check className="mr-2 h-4 w-4" />}
                          {isAdded ? "Added & Syncing" : isAdding ? "Connecting..." : error ? "Retry" : "Add Server"}
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          <div className="text-center">
            <Button
              onClick={() => router.push("/")}
              size="lg"
              disabled={addedServers.size === 0}
              className="bg-amber-500 text-black hover:bg-amber-600 disabled:opacity-40"
            >
              Continue to Dashboard
            </Button>
            {addedServers.size === 0 && (
              <p className="mt-2 text-sm text-muted-foreground">Add at least one server to continue</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── Manual mode (Jellyfin / Emby) ───

  const colors = MANUAL_COLORS[manualType];
  const typeLabel = manualType === "JELLYFIN" ? "Jellyfin" : "Emby";

  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_center,oklch(0.22_0.02_270),oklch(0.14_0.006_270))] p-8">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className={`absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-150 h-150 rounded-full ${colors.glow} blur-3xl`} />
      </div>
      <div className="relative w-full max-w-lg space-y-8">
        <div className="text-center">
          <button
            type="button"
            onClick={handleBack}
            className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <div className={`mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full ${manualType === "JELLYFIN" ? "bg-purple-500/15 ring-1 ring-purple-500/20" : "bg-emerald-500/15 ring-1 ring-emerald-500/20"}`}>
            <Server className={`h-8 w-8 ${manualType === "JELLYFIN" ? "text-purple-400" : "text-emerald-400"}`} />
          </div>
          <h1 className="text-3xl font-bold font-display tracking-tight">Add {typeLabel} Server</h1>
          <p className="mt-2 text-muted-foreground">
            Enter your server details to connect.
          </p>
        </div>

        <Card className={colors.border}>
          <CardContent className="space-y-4 pt-6">
            {manualSelectingLibs ? (
              /* Library selection step */
              <div className="space-y-3">
                <h4 className="text-sm font-medium mb-2">Select Libraries to Sync</h4>
                <div className="space-y-2">
                  {manualLibraries.map((lib) => (
                    <label
                      key={lib.key}
                      className="flex items-center justify-between rounded-lg border px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors"
                    >
                      <div>
                        <span className="text-sm font-medium">{lib.title}</span>
                        <span className="ml-2 text-xs text-muted-foreground">({lib.type})</span>
                      </div>
                      <Switch
                        checked={manualLibSelections[lib.key] ?? true}
                        onCheckedChange={(checked) => setManualLibSelections((prev) => ({ ...prev, [lib.key]: checked }))}
                      />
                    </label>
                  ))}
                  {manualLibraries.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">No compatible libraries found on this server.</p>
                  )}
                </div>
                <Button
                  onClick={confirmManualLibraries}
                  disabled={savingLibraries}
                  className={`w-full ${colors.btn} ${colors.btnHover} ${colors.btnText}`}
                >
                  {savingLibraries && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirm & Sync
                </Button>
              </div>
            ) : manualAdded ? (
              /* Success state */
              <div className="text-center py-4">
                <CheckCircle className={`mx-auto h-12 w-12 ${manualType === "JELLYFIN" ? "text-purple-400" : "text-emerald-400"}`} />
                <p className="mt-3 font-medium">Server added and syncing!</p>
              </div>
            ) : (
              /* Entry form */
              <>
                <div className="space-y-1">
                  <Label htmlFor="manual-name">Server Name (optional)</Label>
                  <Input
                    id="manual-name"
                    placeholder={`My ${typeLabel} Server`}
                    value={manualForm.name}
                    onChange={(e) => { setManualForm((f) => ({ ...f, name: e.target.value })); setManualTestResult(null); }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="manual-url">URL</Label>
                  <Input
                    id="manual-url"
                    placeholder={`http://your-server:${manualType === "JELLYFIN" ? "8096" : "8096"}`}
                    value={manualForm.url}
                    onChange={(e) => { setManualForm((f) => ({ ...f, url: e.target.value })); setManualTestResult(null); }}
                  />
                  <p className="text-xs text-muted-foreground">Must include http:// or https://</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="manual-apikey">API Key</Label>
                  <Input
                    id="manual-apikey"
                    placeholder="API key from dashboard"
                    value={manualForm.apiKey}
                    onChange={(e) => { setManualForm((f) => ({ ...f, apiKey: e.target.value })); setManualTestResult(null); }}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="manual-tls"
                    checked={manualForm.tlsSkipVerify}
                    onCheckedChange={(checked) => { setManualForm((f) => ({ ...f, tlsSkipVerify: checked })); setManualTestResult(null); }}
                  />
                  <Label htmlFor="manual-tls" className="text-sm">Skip TLS verification</Label>
                </div>

                {manualTestResult && (
                  <div className={`flex items-center gap-2 rounded-md p-3 text-sm ${
                    manualTestResult.ok ? "bg-green-500/10 text-green-500" : "bg-destructive/10 text-destructive"
                  }`}>
                    {manualTestResult.ok ? (
                      <>
                        <CheckCircle className="h-4 w-4 shrink-0" />
                        Connection successful — server added
                      </>
                    ) : (
                      <>
                        <XCircle className="h-4 w-4 shrink-0" />
                        Connection failed{manualTestResult.error ? ` — ${manualTestResult.error}` : ""}
                      </>
                    )}
                  </div>
                )}

                {manualError && (
                  <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {manualError}
                  </div>
                )}

                <div className="flex gap-2">
                  {!manualTestResult?.ok ? (
                    <Button
                      onClick={testManualConnection}
                      disabled={manualTesting || !manualForm.url || !manualForm.apiKey}
                      className={`flex-1 ${colors.btn} ${colors.btnHover} ${colors.btnText}`}
                    >
                      {manualTesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plug className="mr-2 h-4 w-4" />}
                      Connect
                    </Button>
                  ) : (
                    <Button
                      onClick={proceedToManualLibraries}
                      disabled={manualAdding}
                      className={`flex-1 ${colors.btn} ${colors.btnHover} ${colors.btnText}`}
                    >
                      {manualAdding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                      Select Libraries
                    </Button>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <div className="text-center">
          <Button
            onClick={() => router.push("/")}
            size="lg"
            disabled={!manualAdded}
            className={`${colors.btn} ${colors.btnHover} ${colors.btnText} disabled:opacity-40`}
          >
            Continue to Dashboard
          </Button>
          {!manualAdded && (
            <p className="mt-2 text-sm text-muted-foreground">Add a server to continue</p>
          )}
        </div>
      </div>
    </div>
  );
}
