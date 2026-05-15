"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  AlertCircle,
  CheckCircle,
  Circle,
  Loader2,
  Save,
  ShieldOff,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SsoConfig {
  ssoEnabled: boolean;
  ssoMode: "OIDC" | "FORWARD_AUTH";
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcClientSecret: string | null;
  oidcScopes: string;
  oidcUsernameClaim: string;
  forwardAuthUserHeader: string;
  forwardAuthEmailHeader: string;
  forwardAuthNameHeader: string;
  overrideActive?: boolean;
}

interface SsoLinkInfo {
  ssoSubject: string | null;
  ssoProvider: string | null;
  ssoEnabled: boolean;
}

/** Returns true if the supplied config has the minimum fields for SSO to work
 *  in its selected mode — matches the server's `isSsoUsable` check. */
function isConfigComplete(c: SsoConfig): boolean {
  if (c.ssoMode === "OIDC") return !!(c.oidcIssuer && c.oidcClientId);
  return !!c.forwardAuthUserHeader;
}

const codeClass = "font-mono text-[0.85em] rounded bg-muted/60 px-1 py-0.5";

export function SsoSection() {
  const [config, setConfig] = useState<SsoConfig | null>(null);
  // The last-saved snapshot of config (sans ssoEnabled, which is its own
  // toggle). Used to detect unsaved changes in step 1.
  const [savedConfigSnapshot, setSavedConfigSnapshot] = useState<string | null>(null);
  const [link, setLink] = useState<SsoLinkInfo>({ ssoSubject: null, ssoProvider: null, ssoEnabled: false });
  const [loading, setLoading] = useState(true);

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [linkSubject, setLinkSubject] = useState("");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [confirmUnlinkOpen, setConfirmUnlinkOpen] = useState(false);

  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [configRes, linkRes] = await Promise.all([
          fetch("/api/settings/sso"),
          fetch("/api/settings/sso/me"),
        ]);
        if (cancelled) return;
        if (configRes.ok) {
          const data = (await configRes.json()) as SsoConfig;
          setConfig(data);
          setSavedConfigSnapshot(snapshotOf(data));
        }
        if (linkRes.ok) setLink(await linkRes.json());
      } catch {
        if (!cancelled) setError("Failed to load SSO settings");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (savedAt === null) return;
    const t = setTimeout(() => setSavedAt(null), 3000);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Derived step states. Computed every render — the values that determine
  // them are cheap (config fields, link state).
  const step1Complete = useMemo(
    () =>
      !!config && isConfigComplete(config) && savedConfigSnapshot === snapshotOf(config),
    [config, savedConfigSnapshot]
  );
  const step2Complete = !!link.ssoSubject && step1Complete;
  const step3Complete = step2Complete && !!config?.ssoEnabled;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!config) return null;

  const updateField = <K extends keyof SsoConfig>(key: K, value: SsoConfig[K]) => {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSavedAt(null);
  };

  const handleSaveConfig = async () => {
    if (!config) return;
    setError(null);
    setSaving(true);
    try {
      // Send everything EXCEPT ssoEnabled. The toggle in step 3 has its own
      // save path and we don't want hitting Save in step 1 to also flip the
      // enable state if the admin had touched it.
      const payload = {
        ssoMode: config.ssoMode,
        oidcIssuer: config.oidcIssuer,
        oidcClientId: config.oidcClientId,
        oidcClientSecret: config.oidcClientSecret,
        oidcScopes: config.oidcScopes,
        oidcUsernameClaim: config.oidcUsernameClaim,
        forwardAuthUserHeader: config.forwardAuthUserHeader,
        forwardAuthEmailHeader: config.forwardAuthEmailHeader,
        forwardAuthNameHeader: config.forwardAuthNameHeader,
      };
      const res = await fetch("/api/settings/sso", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to save");
        return;
      }
      setConfig(data);
      setSavedConfigSnapshot(snapshotOf(data));
      setSavedAt(Date.now());
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  const handleTestDiscovery = async () => {
    if (!config.oidcIssuer) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/sso/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oidcIssuer: config.oidcIssuer }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestResult({ ok: true, message: `Discovery succeeded. Issuer: ${data.issuer}` });
      } else {
        setTestResult({ ok: false, message: data.error || "Discovery failed" });
      }
    } catch {
      setTestResult({ ok: false, message: "Network error" });
    } finally {
      setTesting(false);
    }
  };

  const handleLink = async () => {
    setLinkError(null);
    setLinkNotice(null);
    if (!linkSubject.trim()) {
      setLinkError("Subject is required");
      return;
    }
    setLinking(true);
    try {
      const res = await fetch("/api/settings/sso/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssoSubject: linkSubject.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLinkError(data.error || "Failed to link");
        return;
      }
      setLink(data);
      setLinkSubject("");
    } catch {
      setLinkError("Network error");
    } finally {
      setLinking(false);
    }
  };

  const handleUnlink = async () => {
    setLinkError(null);
    setLinkNotice(null);
    setLinking(true);
    try {
      const res = await fetch("/api/settings/sso/link", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setLinkError(data.error || "Failed to unlink");
        return;
      }
      setLink({
        ssoSubject: data.ssoSubject ?? null,
        ssoProvider: data.ssoProvider ?? null,
        ssoEnabled: data.ssoEnabled ?? false,
      });
      if (data.globalSsoDisabled) {
        setConfig((prev) => (prev ? { ...prev, ssoEnabled: false } : prev));
        setLinkNotice(
          "SSO login has been turned off automatically since no identity is linked. Link an identity above and toggle Enable SSO Login below to use SSO again."
        );
      }
    } catch {
      setLinkError("Network error");
    } finally {
      setLinking(false);
    }
  };

  const handleToggleSsoEnabled = async (enabled: boolean) => {
    setEnableError(null);
    setTogglingEnabled(true);
    try {
      const res = await fetch("/api/settings/sso", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssoEnabled: enabled }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEnableError(data.error || "Failed to update");
        return;
      }
      setConfig(data);
    } catch {
      setEnableError("Network error");
    } finally {
      setTogglingEnabled(false);
    }
  };

  return (
    <div className="space-y-6">
      {config.overrideActive && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-400">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">SSO disabled by environment override</p>
            <p className="text-xs">
              <code className={codeClass}>SSO_DISABLE_OVERRIDE</code> is set, so
              SSO login is forcibly disabled regardless of the steps below.
              Unset the variable and restart the container to re-enable SSO.
              The stored configuration is preserved.
            </p>
          </div>
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        Setting up SSO is a three-step process: configure your identity
        provider, link your account to it, then turn the SSO login button on.
        Each step unlocks the next.
      </p>

      {/* ── Step 1: Configure the IdP ─────────────────────────────────── */}
      <StepCard
        number={1}
        title="Configure your identity provider"
        description="Tell Librariarr how to talk to your IdP. Settings are not used for login until you complete all three steps."
        status={step1Complete ? "complete" : "current"}
      >
        <div className="space-y-2">
          <Label>SSO Mode</Label>
          <Select
            value={config.ssoMode}
            onValueChange={(v) => updateField("ssoMode", v as "OIDC" | "FORWARD_AUTH")}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="OIDC">OIDC (OpenID Connect)</SelectItem>
              <SelectItem value="FORWARD_AUTH">Forward Auth (proxy headers)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {config.ssoMode === "OIDC" ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="oidc-issuer">Issuer URL</Label>
              <Input
                id="oidc-issuer"
                placeholder="https://auth.example.com/application/o/librariarr/"
                value={config.oidcIssuer ?? ""}
                onChange={(e) => updateField("oidcIssuer", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The base URL where{" "}
                <code className={codeClass}>.well-known/openid-configuration</code>{" "}
                is served.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="oidc-client-id">Client ID</Label>
              <Input
                id="oidc-client-id"
                value={config.oidcClientId ?? ""}
                onChange={(e) => updateField("oidcClientId", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="oidc-client-secret">Client Secret</Label>
              <Input
                id="oidc-client-secret"
                type="password"
                placeholder="(set only if your provider requires one)"
                value={config.oidcClientSecret ?? ""}
                onChange={(e) => updateField("oidcClientSecret", e.target.value)}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="oidc-scopes">Scopes</Label>
                <Input
                  id="oidc-scopes"
                  value={config.oidcScopes}
                  onChange={(e) => updateField("oidcScopes", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="oidc-username-claim">Username Claim</Label>
                <Input
                  id="oidc-username-claim"
                  value={config.oidcUsernameClaim}
                  onChange={(e) => updateField("oidcUsernameClaim", e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={testing || !config.oidcIssuer}
                onClick={handleTestDiscovery}
              >
                {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Test Discovery
              </Button>
              {testResult && (
                <span
                  className={
                    testResult.ok ? "text-xs text-green-500" : "text-xs text-destructive"
                  }
                >
                  {testResult.message}
                </span>
              )}
            </div>
            <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              Register a confidential client at your IdP and set the redirect
              URI to{" "}
              <code className={codeClass}>
                {typeof window !== "undefined"
                  ? `${window.location.origin}/api/auth/sso/oidc/callback`
                  : "/api/auth/sso/oidc/callback"}
              </code>
              .
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="fwd-user">User Header</Label>
                <Input
                  id="fwd-user"
                  value={config.forwardAuthUserHeader}
                  onChange={(e) => updateField("forwardAuthUserHeader", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fwd-email">Email Header</Label>
                <Input
                  id="fwd-email"
                  value={config.forwardAuthEmailHeader}
                  onChange={(e) => updateField("forwardAuthEmailHeader", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fwd-name">Name Header</Label>
                <Input
                  id="fwd-name"
                  value={config.forwardAuthNameHeader}
                  onChange={(e) => updateField("forwardAuthNameHeader", e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Security warning</p>
                <p className="text-xs">
                  Forward auth trusts the identity in these headers. Only
                  enable it when Librariarr is reachable <em>exclusively</em>{" "}
                  through your authenticating proxy — direct network access
                  would let attackers spoof the headers.
                </p>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
        {savedAt && (
          <div className="flex items-center gap-2 rounded-md bg-green-500/10 p-3 text-sm text-green-500">
            <CheckCircle className="h-4 w-4 shrink-0" />
            Configuration saved
          </div>
        )}

        <Button size="sm" disabled={saving || !isConfigComplete(config)} onClick={handleSaveConfig}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save Configuration
        </Button>
      </StepCard>

      {/* ── Step 2: Link your identity ────────────────────────────────── */}
      <StepCard
        number={2}
        title="Link your SSO identity"
        description={
          step1Complete
            ? "Paste your IdP subject identifier (OIDC sub claim, or the username your reverse proxy sends as the user header)."
            : "Save your configuration in step 1 first."
        }
        status={
          step2Complete ? "complete" : step1Complete ? "current" : "locked"
        }
        disabled={!step1Complete}
      >
        {link.ssoSubject ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle className="h-4 w-4 text-green-500" />
              <span>
                Linked to <strong>{link.ssoSubject}</strong>
                {link.ssoProvider ? ` (${link.ssoProvider})` : ""}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={linking}
              onClick={() => setConfirmUnlinkOpen(true)}
            >
              <ShieldOff className="mr-2 h-4 w-4" />
              Unlink SSO
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <XCircle className="h-4 w-4" />
              <span>No SSO identity linked</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                placeholder="OIDC sub or proxy username"
                value={linkSubject}
                onChange={(e) => setLinkSubject(e.target.value)}
                disabled={!step1Complete}
              />
              <Button
                size="sm"
                disabled={linking || !linkSubject.trim() || !step1Complete}
                onClick={handleLink}
              >
                {linking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Link Identity
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Not sure what your <code className={codeClass}>sub</code> is? Save
              the configuration above, sign out, click <em>Sign in with SSO</em>,
              authenticate at your IdP, then check the Librariarr logs for the
              line starting with{" "}
              <code className={codeClass}>OIDC login rejected: no linked
              account for sub=…</code>
              {" "}— copy that value back here.
            </p>
          </div>
        )}
        {linkError && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {linkError}
          </div>
        )}
        {linkNotice && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-400">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{linkNotice}</span>
          </div>
        )}
      </StepCard>

      {/* ── Step 3: Enable SSO Login ──────────────────────────────────── */}
      <StepCard
        number={3}
        title="Enable SSO login"
        description={
          step2Complete
            ? "Turn the SSO login button on. The local username/password form will be hidden while this is on."
            : "Link your identity in step 2 first."
        }
        status={
          step3Complete ? "complete" : step2Complete ? "current" : "locked"
        }
        disabled={!step2Complete}
      >
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">SSO login</p>
            <p className="text-xs text-muted-foreground">
              {config.ssoEnabled
                ? "Active. The login page shows a Sign in with SSO button."
                : "Off. Toggle on to activate."}
            </p>
          </div>
          <Switch
            checked={config.ssoEnabled}
            disabled={togglingEnabled || !step2Complete}
            onCheckedChange={handleToggleSsoEnabled}
          />
        </div>
        {enableError && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {enableError}
          </div>
        )}
      </StepCard>

      {/* Unlink confirmation — destructive action. */}
      <AlertDialog open={confirmUnlinkOpen} onOpenChange={setConfirmUnlinkOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink SSO identity?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears your linked SSO subject. If SSO login is currently
              enabled, it will also be turned off automatically — otherwise
              the local form would stay hidden on the login page with no way
              back in. Other active sessions for your account will be
              invalidated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={linking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmUnlinkOpen(false);
                handleUnlink();
              }}
              disabled={linking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {linking ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ShieldOff className="mr-2 h-4 w-4" />
              )}
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Serializes the config fields used in step 1 so we can detect unsaved
 *  changes by comparing against the snapshot taken at last save / load. */
function snapshotOf(c: SsoConfig): string {
  return JSON.stringify({
    ssoMode: c.ssoMode,
    oidcIssuer: c.oidcIssuer,
    oidcClientId: c.oidcClientId,
    oidcClientSecret: c.oidcClientSecret,
    oidcScopes: c.oidcScopes,
    oidcUsernameClaim: c.oidcUsernameClaim,
    forwardAuthUserHeader: c.forwardAuthUserHeader,
    forwardAuthEmailHeader: c.forwardAuthEmailHeader,
    forwardAuthNameHeader: c.forwardAuthNameHeader,
  });
}

type StepStatus = "current" | "complete" | "locked";

interface StepCardProps {
  number: 1 | 2 | 3;
  title: string;
  description: string;
  status: StepStatus;
  disabled?: boolean;
  children: React.ReactNode;
}

/** Renders one of the three configuration steps with a status badge and a
 *  dimmed appearance when locked behind earlier incomplete steps. */
function StepCard({ number, title, description, status, disabled, children }: StepCardProps) {
  return (
    <Card className={cn(disabled && "opacity-60")}>
      <CardHeader>
        <div className="flex items-center gap-3">
          <StepBadge number={number} status={status} />
          <div className="flex-1">
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription className="mt-1">{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className={cn("space-y-4", disabled && "pointer-events-none")}>
        {children}
      </CardContent>
    </Card>
  );
}

function StepBadge({ number, status }: { number: number; status: StepStatus }) {
  if (status === "complete") {
    return (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-500/10 text-green-500">
        <CheckCircle className="h-5 w-5" />
      </div>
    );
  }
  if (status === "locked") {
    return (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Circle className="h-5 w-5" />
      </div>
    );
  }
  // current
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary font-semibold text-sm">
      {number}
    </div>
  );
}
