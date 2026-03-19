"use client";

import { useState, useEffect } from "react";
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
import { Server, Loader2, Check, AlertCircle, Pencil, ShieldOff } from "lucide-react";
import { Logo } from "@/components/logo";

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

function getDefaultUrl(connections: PlexConnection[]): string {
  const remote = connections.find((c) => !c.local);
  return (remote || connections[0])?.uri ?? "";
}

export default function OnboardingPage() {
  const router = useRouter();
  const [servers, setServers] = useState<PlexServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingServer, setAddingServer] = useState<string | null>(null);
  const [addedServers, setAddedServers] = useState<Set<string>>(new Set());
  const [editingServer, setEditingServer] = useState<string | null>(null);
  const [customUrls, setCustomUrls] = useState<Record<string, string>>({});
  const [tlsSkipVerify, setTlsSkipVerify] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Library selection state
  const [selectingLibraries, setSelectingLibraries] = useState<string | null>(null); // clientIdentifier
  const [serverIdMap, setServerIdMap] = useState<Record<string, string>>({}); // clientIdentifier -> server DB id
  const [serverLibraries, setServerLibraries] = useState<Record<string, DiscoveredLibrary[]>>({});
  const [librarySelections, setLibrarySelections] = useState<Record<string, Record<string, boolean>>>({});
  const [savingLibraries, setSavingLibraries] = useState(false);

  useEffect(() => {
    fetchServers();
  }, []);

  const fetchServers = async () => {
    try {
      // Fetch Plex servers and existing servers in parallel
      const [plexRes, existingRes] = await Promise.all([
        fetch("/api/auth/plex/servers"),
        fetch("/api/servers"),
      ]);
      const plexData = await plexRes.json();
      const existingData = await existingRes.json();

      const fetchedServers: PlexServer[] = plexData.servers || [];
      setServers(fetchedServers);

      const urls: Record<string, string> = {};
      for (const s of fetchedServers) {
        urls[s.clientIdentifier] = getDefaultUrl(s.connections);
      }
      setCustomUrls(urls);

      // Pre-mark servers that already exist in the database
      const existingMachineIds = new Set(
        (existingData.servers || []).map((s: { machineId: string }) => s.machineId)
      );
      const alreadyAdded = new Set<string>();
      for (const s of fetchedServers) {
        if (existingMachineIds.has(s.clientIdentifier)) {
          alreadyAdded.add(s.clientIdentifier);
        }
      }
      if (alreadyAdded.size > 0) {
        setAddedServers(alreadyAdded);
      }
    } catch (error) {
      console.error("Failed to fetch servers:", error);
    } finally {
      setLoading(false);
    }
  };

  const addServer = async (server: PlexServer) => {
    setAddingServer(server.clientIdentifier);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[server.clientIdentifier];
      return next;
    });

    const url =
      customUrls[server.clientIdentifier] ||
      getDefaultUrl(server.connections);

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
        const message = data.detail
          ? `${data.error} — ${data.detail}`
          : data.error;
        setErrors((prev) => ({
          ...prev,
          [server.clientIdentifier]: message,
        }));
        setEditingServer(server.clientIdentifier);
        return;
      }

      // If this is an updated server (already existed), mark as added and skip library selection
      if (data.updated) {
        setAddedServers((prev) => new Set(prev).add(server.clientIdentifier));
        setEditingServer(null);
        return;
      }

      // Store the server DB id and fetch libraries for selection
      setServerIdMap((prev) => ({ ...prev, [server.clientIdentifier]: data.server.id }));

      try {
        const libRes = await fetch(`/api/servers/${data.server.id}/libraries`);
        const libData = await libRes.json();
        const libs: DiscoveredLibrary[] = libData.libraries || [];

        setServerLibraries((prev) => ({ ...prev, [server.clientIdentifier]: libs }));
        // All enabled by default
        const selections: Record<string, boolean> = {};
        for (const lib of libs) {
          selections[lib.key] = true;
        }
        setLibrarySelections((prev) => ({ ...prev, [server.clientIdentifier]: selections }));
        setSelectingLibraries(server.clientIdentifier);
      } catch {
        // If library fetch fails, just add and sync all
        setAddedServers((prev) => new Set(prev).add(server.clientIdentifier));
        await fetch(`/api/servers/${data.server.id}/sync`, { method: "POST" });
      }

      setEditingServer(null);
    } catch {
      setErrors((prev) => ({
        ...prev,
        [server.clientIdentifier]:
          "Network error — could not reach Librariarr API",
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
      // Save library enabled/disabled state
      await fetch(`/api/servers/${serverId}/libraries`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          libraries: libs.map((lib) => ({
            key: lib.key,
            enabled: selections[lib.key] ?? true,
          })),
        }),
      });

      // Trigger sync
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
      [clientIdentifier]: {
        ...prev[clientIdentifier],
        [key]: !prev[clientIdentifier]?.[key],
      },
    }));
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-150 h-150 rounded-full bg-amber-500/5 blur-3xl" />
      </div>
      <div className="relative w-full max-w-5xl space-y-8">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/15 ring-1 ring-amber-500/20">
            <Logo size={32} />
          </div>
          <h1 className="text-3xl font-bold bg-linear-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">Select Your Plex Servers</h1>
          <p className="mt-2 text-muted-foreground">
            Choose which servers to connect. You can select which libraries to
            sync.
          </p>
        </div>

        {servers.length === 0 ? (
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
            {servers.map((server) => {
              const id = server.clientIdentifier;
              const isAdded = addedServers.has(id);
              const isAdding = addingServer === id;
              const isEditing = editingServer === id;
              const isSelectingLibs = selectingLibraries === id;
              const error = errors[id];
              const currentUrl =
                customUrls[id] || getDefaultUrl(server.connections);

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
                    {/* URL display / editor */}
                    {isEditing ? (
                      <div className="space-y-2">
                        <Label htmlFor={`url-${id}`}>Server URL</Label>
                        <Input
                          id={`url-${id}`}
                          value={currentUrl}
                          onChange={(e) =>
                            setCustomUrls((prev) => ({
                              ...prev,
                              [id]: e.target.value,
                            }))
                          }
                          placeholder="http://your-server:32400"
                        />
                        {server.connections.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-xs text-muted-foreground">
                              Known addresses:
                            </p>
                            {server.connections.map((conn) => (
                              <button
                                key={conn.uri}
                                type="button"
                                onClick={() =>
                                  setCustomUrls((prev) => ({
                                    ...prev,
                                    [id]: conn.uri,
                                  }))
                                }
                                className={`block w-full rounded px-2 py-1 text-left text-xs transition-colors ${
                                  currentUrl === conn.uri
                                    ? "bg-amber-500/10 text-amber-400"
                                    : "text-muted-foreground hover:bg-muted"
                                }`}
                              >
                                {conn.uri}
                                {conn.local && (
                                  <span className="ml-1 opacity-60">
                                    (local)
                                  </span>
                                )}
                              </button>
                            ))}
                          </div>
                        )}

                        {/* TLS skip verify checkbox */}
                        <label className="flex items-start gap-2 cursor-pointer pt-1">
                          <input
                            type="checkbox"
                            checked={!!tlsSkipVerify[id]}
                            onChange={(e) =>
                              setTlsSkipVerify((prev) => ({
                                ...prev,
                                [id]: e.target.checked,
                              }))
                            }
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
                        <span className="truncate text-xs text-muted-foreground font-mono">
                          {currentUrl}
                        </span>
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

                    {/* Error message */}
                    {error && (
                      <div className="flex gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <p>{error}</p>
                      </div>
                    )}

                    {/* Library selection step */}
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
                                  <span className="ml-2 text-xs text-muted-foreground">
                                    ({lib.type})
                                  </span>
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
                          {savingLibraries && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          Confirm & Sync
                        </Button>
                      </div>
                    )}

                    {/* Action button — hide when selecting libraries */}
                    {!isSelectingLibs && (
                      <Button
                        onClick={() => addServer(server)}
                        disabled={isAdding || isAdded}
                        className={`w-full ${isAdded ? "bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20" : "bg-amber-500 text-black hover:bg-amber-600"}`}
                        variant={isAdded ? "secondary" : "default"}
                      >
                        {isAdding && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        {isAdded && <Check className="mr-2 h-4 w-4" />}
                        {isAdded
                          ? "Added & Syncing"
                          : isAdding
                            ? "Connecting..."
                            : error
                              ? "Retry"
                              : "Add Server"}
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
            <p className="mt-2 text-sm text-muted-foreground">
              Add at least one server to continue
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
