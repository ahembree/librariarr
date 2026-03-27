"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { usePlexOAuth } from "@/hooks/use-plex-oauth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, RotateCcw, Loader2 } from "lucide-react";
import { Logo } from "@/components/logo";

export default function LoginPage() {
  const router = useRouter();
  const [localAuthEnabled, setLocalAuthEnabled] = useState(false);
  const [localUsername, setLocalUsername] = useState("");
  const [localPassword, setLocalPassword] = useState("");
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [showSetupForm, setShowSetupForm] = useState(false);
  const [setupUsername, setSetupUsername] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupConfirmPassword, setSetupConfirmPassword] = useState("");
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [checkingSetup, setCheckingSetup] = useState(true);
  const [showRestoreFlow, setShowRestoreFlow] = useState(false);
  const [backupFiles, setBackupFiles] = useState<{ filename: string; createdAt: string; size: number; tables?: Record<string, number>; encrypted?: boolean; configOnly?: boolean }[]>([]);
  const [selectedBackup, setSelectedBackup] = useState<string>("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<string | null>(null);

  const completeAuth = useCallback(async () => {
    try {
      const serversRes = await fetch("/api/servers");
      const serversData = await serversRes.json();
      if (serversData.servers?.length > 0) {
        router.push("/");
        return;
      }
    } catch {}
    router.push("/onboarding");
  }, [router]);

  const { startAuth: handlePlexLogin, cancel: cancelPlexAuth, isLoading: plexLoading, error: plexError, authUrl } = usePlexOAuth({
    onSuccess: async (authToken) => {
      const res = await fetch("/api/auth/plex/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authToken }),
      });
      const result = await res.json();
      if (result.authenticated) {
        await completeAuth();
      } else if (result.error) {
        throw new Error(result.error);
      }
    },
  });

  // On mount: check setup state
  useEffect(() => {
    let cancelled = false;

    async function checkSetup() {
      try {
        const res = await fetch("/api/auth/check-setup");
        const data = await res.json();

        if (cancelled) return;

        setSetupRequired(data.setupRequired ?? false);
        setLocalAuthEnabled(data.localAuthEnabled);
      } catch {
        // If check fails, just show Plex login
      } finally {
        if (!cancelled) setCheckingSetup(false);
      }
    }

    checkSetup();
    return () => {
      cancelled = true;
    };
  }, [router]);


  const handleLocalLogin = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLocalError(null);
    setLocalLoading(true);

    try {
      const res = await fetch("/api/auth/local/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: localUsername, password: localPassword }),
      });
      const data = await res.json();

      if (!res.ok) {
        setLocalError(data.error || "Login failed");
        setLocalLoading(false);
        return;
      }

      try {
        const serversRes = await fetch("/api/servers");
        const serversData = await serversRes.json();
        if (serversData.servers?.length > 0) {
          router.push("/");
          return;
        }
      } catch {}
      router.push("/onboarding");
    } catch {
      setLocalError("Login failed. Please try again.");
      setLocalLoading(false);
    }
  };

  const handleSetup = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSetupError(null);

    if (setupUsername.trim().length < 3) {
      setSetupError("Username must be at least 3 characters");
      return;
    }

    if (setupPassword.length < 8) {
      setSetupError("Password must be at least 8 characters");
      return;
    }

    if (setupPassword !== setupConfirmPassword) {
      setSetupError("Passwords do not match");
      return;
    }

    setSetupLoading(true);
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: setupUsername.trim(), password: setupPassword }),
      });

      const data = await res.json();

      if (!res.ok) {
        setSetupError(data.error || "Setup failed");
        setSetupLoading(false);
        return;
      }

      router.push("/onboarding");
    } catch {
      setSetupError("Setup failed. Please try again.");
      setSetupLoading(false);
    }
  };

  const handleShowRestore = async () => {
    setShowRestoreFlow(true);
    setRestoreError(null);
    setLoadingBackups(true);
    try {
      const res = await fetch("/api/backup/list-setup");
      const data = await res.json();
      if (!res.ok) {
        setRestoreError(data.error || "Failed to load backups");
        setBackupFiles([]);
      } else {
        setBackupFiles(data.backups || []);
        if (data.backups?.length > 0) {
          setSelectedBackup(data.backups[0].filename);
        }
      }
    } catch {
      setRestoreError("Failed to load backups");
    } finally {
      setLoadingBackups(false);
    }
  };

  const selectedBackupEncrypted = backupFiles.find((b) => b.filename === selectedBackup)?.encrypted;

  const handleRestore = async () => {
    if (!selectedBackup) return;
    if (selectedBackupEncrypted && !restorePassphrase) {
      setRestoreError("Passphrase is required for encrypted backups");
      return;
    }
    setRestoreLoading(true);
    setRestoreError(null);
    setRestoreProgress(null);
    try {
      const body: Record<string, string> = { filename: selectedBackup };
      if (restorePassphrase) body.passphrase = restorePassphrase;
      const res = await fetch("/api/backup/restore-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.body) {
        setRestoreError("Restore failed");
        setRestoreLoading(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastError: string | null = null;
      let completed = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "progress") {
              setRestoreProgress(event.message);
            } else if (event.type === "complete") {
              completed = true;
            } else if (event.type === "error") {
              lastError = event.message;
            }
          } catch { /* ignore malformed lines */ }
        }
      }

      if (completed) {
        window.location.href = "/login";
      } else {
        setRestoreError(lastError || "Restore failed");
        setRestoreLoading(false);
      }
    } catch {
      setRestoreError("Restore failed. Please try again.");
      setRestoreLoading(false);
    }
  };

  if (checkingSetup) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-105">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-24 w-24 items-center justify-center rounded-full bg-primary/10">
            <Logo size={96} />
          </div>
          <CardTitle className="text-2xl">Welcome to Librariarr</CardTitle>
          <CardDescription>
            Manage and monitor your media libraries across Plex, Jellyfin, and
            Emby
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Plex login button */}
          <div className="space-y-2">
            <Button
              onClick={handlePlexLogin}
              disabled={plexLoading}
              className="w-full cursor-pointer bg-[#cc7b19] text-white hover:bg-[#e5a00d] disabled:opacity-60"
              size="lg"
            >
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                className="mr-2 h-5 w-5 shrink-0"
                aria-hidden="true"
              >
                <path d="M3.987 8.409c-.96 0-1.587.28-2.12.933v-.72H0v8.88s.038.018.127.037c.138.03.821.187 1.331-.249.441-.377.542-.814.542-1.318v-1.283c.533.573 1.147.813 2 .813 1.84 0 3.253-1.493 3.253-3.48 0-2.12-1.36-3.613-3.266-3.613Zm16.748 5.595.406.591c.391.614.894.906 1.492.908.621-.012 1.064-.562 1.226-.755 0 0-.307-.27-.686-.72-.517-.614-1.214-1.755-1.24-1.803l-1.198 1.779Zm-3.205-1.955c0-2.08-1.52-3.64-3.52-3.64s-3.467 1.587-3.467 3.573a3.48 3.48 0 0 0 3.507 3.52c1.413 0 2.626-.84 3.253-2.293h-2.04l-.093.093c-.427.4-.72.533-1.227.533-.787 0-1.373-.506-1.453-1.266h4.986c.04-.214.054-.307.054-.52Zm-7.671-.219c0 .769.11 1.701.868 2.722l.056.069c-.306.526-.742.88-1.248.88-.399 0-.814-.211-1.138-.579a2.177 2.177 0 0 1-.538-1.441V6.409H9.86l-.001 5.421Zm9.283 3.46h-2.39l2.247-3.332-2.247-3.335h2.39l2.248 3.335-2.248 3.332Zm1.593-1.286Zm-17.162-.342c-.933 0-1.68-.773-1.68-1.72s.76-1.666 1.68-1.666c.92 0 1.68.733 1.68 1.68 0 .946-.733 1.706-1.68 1.706Zm18.361-1.974L24 8.622h-2.391l-.87 1.293 1.195 1.773Zm-9.404-.466c.16-.706.72-1.133 1.493-1.133.773 0 1.373.467 1.507 1.133h-3Z" />
              </svg>
              {plexLoading ? "Waiting for Plex authentication..." : "Sign in with Plex"}
            </Button>
            {plexLoading && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full cursor-pointer"
                onClick={cancelPlexAuth}
              >
                Cancel
              </Button>
            )}
          </div>
          {authUrl && plexLoading && (
            <p className="text-center text-sm text-muted-foreground">
              A new window should have opened. If not,{" "}
              <a
                href={authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >
                click here
              </a>{" "}
              and return to this tab when done.
            </p>
          )}
          {plexError && (
            <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {plexError}
            </div>
          )}
          {/* Setup prompt when no account exists */}
          {setupRequired && (
            <>
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">or</span>
                </div>
              </div>
              {!showSetupForm ? (
                <Button
                  onClick={() => setShowSetupForm(true)}
                  className="w-full cursor-pointer"
                  size="lg"
                >
                  Create Local Account
                </Button>
              ) : (
                <form onSubmit={handleSetup} className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="setup-username">Username</Label>
                    <Input
                      id="setup-username"
                      type="text"
                      autoComplete="username"
                      value={setupUsername}
                      onChange={(e) => setSetupUsername(e.target.value)}
                      placeholder="admin"
                      disabled={setupLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="setup-password">Password</Label>
                    <Input
                      id="setup-password"
                      type="password"
                      autoComplete="new-password"
                      value={setupPassword}
                      onChange={(e) => setSetupPassword(e.target.value)}
                      placeholder="At least 8 characters"
                      disabled={setupLoading}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="setup-confirm-password">Confirm Password</Label>
                    <Input
                      id="setup-confirm-password"
                      type="password"
                      autoComplete="new-password"
                      value={setupConfirmPassword}
                      onChange={(e) => setSetupConfirmPassword(e.target.value)}
                      placeholder="Repeat password"
                      disabled={setupLoading}
                    />
                  </div>
                  {setupError && (
                    <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      {setupError}
                    </div>
                  )}
                  <Button
                    type="submit"
                    className="w-full cursor-pointer"
                    size="lg"
                    disabled={setupLoading}
                  >
                    {setupLoading ? "Creating account..." : "Create Account"}
                  </Button>
                </form>
              )}
              {/* Restore from backup option */}
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">or</span>
                </div>
              </div>
              {!showRestoreFlow ? (
                <Button
                  variant="outline"
                  onClick={handleShowRestore}
                  className="w-full cursor-pointer"
                  size="lg"
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Restore from Backup
                </Button>
              ) : (
                <div className="space-y-3">
                  {loadingBackups ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      <span className="ml-2 text-sm text-muted-foreground">Loading backups...</span>
                    </div>
                  ) : backupFiles.length === 0 ? (
                    <div className="flex items-center gap-2 rounded-md bg-muted p-3 text-sm text-muted-foreground">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      No backup files found. Place backup files in the /config/backups directory.
                    </div>
                  ) : (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="backup-select">Select Backup</Label>
                        <Select value={selectedBackup} onValueChange={(v) => { setSelectedBackup(v); setRestorePassphrase(""); setRestoreError(null); }}>
                          <SelectTrigger id="backup-select" className="w-full">
                            <SelectValue placeholder="Choose a backup..." />
                          </SelectTrigger>
                          <SelectContent>
                            {backupFiles.map((b) => (
                              <SelectItem key={b.filename} value={b.filename}>
                                {new Date(b.createdAt).toLocaleString()} ({b.size < 1024 * 1024 ? `${(b.size / 1024).toFixed(1)} KB` : `${(b.size / 1024 / 1024).toFixed(1)} MB`}){b.tables && Object.keys(b.tables).length > 0 ? ` ${Object.values(b.tables).reduce((a, c) => a + c, 0).toLocaleString()} rows` : ""}{b.encrypted ? " (encrypted)" : ""}{b.configOnly !== undefined ? (b.configOnly !== false ? " (config)" : " (full)") : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {selectedBackupEncrypted && (
                        <div className="space-y-2">
                          <Label htmlFor="restore-passphrase">Encryption Passphrase</Label>
                          <Input
                            id="restore-passphrase"
                            type="password"
                            value={restorePassphrase}
                            onChange={(e) => setRestorePassphrase(e.target.value)}
                            placeholder="Enter backup passphrase"
                            disabled={restoreLoading}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleRestore();
                              }
                            }}
                          />
                        </div>
                      )}
                      <Button
                        onClick={handleRestore}
                        className="w-full cursor-pointer"
                        size="lg"
                        disabled={restoreLoading || !selectedBackup || (selectedBackupEncrypted && !restorePassphrase)}
                      >
                        {restoreLoading ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Restoring...
                          </>
                        ) : (
                          "Restore Selected Backup"
                        )}
                      </Button>
                      {restoreLoading && restoreProgress && (
                        <p className="text-xs text-muted-foreground text-center">{restoreProgress}</p>
                      )}
                    </>
                  )}
                  {restoreError && (
                    <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      {restoreError}
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full cursor-pointer"
                    onClick={() => {
                      setShowRestoreFlow(false);
                      setRestoreError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </>
          )}
          {/* Local auth form */}
          {localAuthEnabled && (
            <>
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">or</span>
                </div>
              </div>
              <form onSubmit={handleLocalLogin} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    type="text"
                    autoComplete="username"
                    value={localUsername}
                    onChange={(e) => setLocalUsername(e.target.value)}
                    disabled={localLoading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    value={localPassword}
                    onChange={(e) => setLocalPassword(e.target.value)}
                    disabled={localLoading}
                  />
                </div>
                {localError && (
                  <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {localError}
                  </div>
                )}
                <Button
                  type="submit"
                  className="w-full cursor-pointer"
                  size="lg"
                  disabled={localLoading}
                >
                  {localLoading ? "Signing in..." : "Sign In"}
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
