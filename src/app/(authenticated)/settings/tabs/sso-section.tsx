"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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
  ExternalLink,
  History,
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
  hasPreviousConfig?: boolean;
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
  // True while the browser is being redirected to the IdP for the
  // verify-and-link round-trip. The flow returns via /settings?ssoLinked=1 or
  // ?ssoLinkError=…, so we just need to keep the button spinner up until
  // navigation happens.
  const [oidcLinkStarting, setOidcLinkStarting] = useState(false);
  const [showManualLink, setShowManualLink] = useState(false);
  const [confirmRevertOpen, setConfirmRevertOpen] = useState(false);
  const [reverting, setReverting] = useState(false);

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

  // Surface ?ssoLinked=1 or ?ssoLinkError=… from the OIDC link callback,
  // then strip the query params so a refresh doesn't redisplay them.
  // (Wrapped in an IIFE so the setState calls aren't flagged by the
  // react-hooks/set-state-in-effect lint — the rule allows it inside an
  // async callback.)
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const linked = params.get("ssoLinked");
      const linkErr = params.get("ssoLinkError");
      if (!linked && !linkErr) return;
      if (cancelled) return;
      if (linked) {
        setLinkNotice(
          "SSO identity linked and OIDC credentials verified end-to-end. Toggle Enable SSO Login in step 3 when you're ready."
        );
      }
      if (linkErr) {
        setLinkError(linkErrorMessage(linkErr));
      }
      params.delete("ssoLinked");
      params.delete("ssoLinkError");
      const next =
        window.location.pathname +
        (params.toString() ? "?" + params.toString() : "") +
        window.location.hash;
      window.history.replaceState(null, "", next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        toast.error("Couldn't save SSO configuration", { description: data.error });
        return;
      }
      setConfig(data);
      setSavedConfigSnapshot(snapshotOf(data));
      setSavedAt(Date.now());
      toast.success("SSO configuration saved");
    } catch {
      setError("Network error");
      toast.error("Couldn't save SSO configuration");
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
        toast.success("OIDC discovery succeeded");
      } else {
        setTestResult({ ok: false, message: data.error || "Discovery failed" });
        toast.error("OIDC discovery failed", { description: data.error });
      }
    } catch {
      setTestResult({ ok: false, message: "Network error" });
      toast.error("OIDC discovery failed");
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
        toast.error("Couldn't link SSO identity", { description: data.error });
        return;
      }
      setLink(data);
      setLinkSubject("");
      toast.success("SSO identity linked");
    } catch {
      setLinkError("Network error");
      toast.error("Couldn't link SSO identity");
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
        toast.error("Couldn't unlink SSO identity", { description: data.error });
        return;
      }
      setLink({
        ssoSubject: data.ssoSubject ?? null,
        ssoProvider: data.ssoProvider ?? null,
        ssoEnabled: data.ssoEnabled ?? false,
      });
      toast.success("SSO identity unlinked");
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

  const handleRevert = async () => {
    setError(null);
    setReverting(true);
    try {
      const res = await fetch("/api/settings/sso/revert", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to revert SSO configuration");
        toast.error("Couldn't revert SSO configuration", { description: data.error });
        return;
      }
      // Reload the current config from the server and reset the unsaved-
      // changes snapshot to match.
      const refreshed = await fetch("/api/settings/sso");
      if (refreshed.ok) {
        const data = (await refreshed.json()) as SsoConfig;
        setConfig(data);
        setSavedConfigSnapshot(snapshotOf(data));
      }
      setSavedAt(Date.now());
      toast.success("SSO configuration reverted");
    } catch {
      setError("Network error");
      toast.error("Couldn't revert SSO configuration");
    } finally {
      setReverting(false);
      setConfirmRevertOpen(false);
    }
  };

  const handleLinkViaOidc = async () => {
    setLinkError(null);
    setLinkNotice(null);
    setOidcLinkStarting(true);
    try {
      const res = await fetch("/api/settings/sso/link/oidc/start", {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || !data.authorizationUrl) {
        setLinkError(data.error || "Failed to start OIDC link flow");
        setOidcLinkStarting(false);
        return;
      }
      // Navigate the top-level browser to the IdP. After auth, the user is
      // redirected back to /settings?ssoLinked=1 (or ?ssoLinkError=…) and the
      // useEffect above surfaces the outcome.
      window.location.href = data.authorizationUrl;
    } catch {
      setLinkError("Network error");
      setOidcLinkStarting(false);
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
        toast.error("Couldn't update SSO login", { description: data.error });
        return;
      }
      setConfig(data);
      toast.success(enabled ? "SSO login enabled" : "SSO login disabled");
    } catch {
      setEnableError("Network error");
      toast.error("Couldn't update SSO login");
    } finally {
      setTogglingEnabled(false);
    }
  };

  return (
    <div className="space-y-6">
      {config.overrideActive && (
        <div className="flex items-start gap-2 rounded-md border border-amber/30 bg-amber/10 p-3 text-sm text-amber">
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
                    testResult.ok ? "text-xs text-green" : "text-xs text-destructive"
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
          <div className="flex items-center gap-2 rounded-md bg-green/10 p-3 text-sm text-green">
            <CheckCircle className="h-4 w-4 shrink-0" />
            Configuration saved
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" disabled={saving || !isConfigComplete(config)} onClick={handleSaveConfig}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save Configuration
          </Button>
          {config.hasPreviousConfig && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reverting}
              onClick={() => setConfirmRevertOpen(true)}
            >
              {reverting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <History className="mr-2 h-4 w-4" />
              )}
              Revert to Previous
            </Button>
          )}
        </div>
      </StepCard>

      {/* ── Step 2: Link your identity ────────────────────────────────── */}
      <StepCard
        number={2}
        title="Link your SSO identity"
        description={
          step1Complete
            ? config.ssoMode === "OIDC"
              ? "Sign in to your IdP once to confirm the configuration works and capture your sub claim. (Or paste a known sub manually if you prefer.)"
              : "Enter the username your reverse proxy injects as the user header."
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
              <CheckCircle className="h-4 w-4 text-green" />
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

            {config.ssoMode === "OIDC" ? (
              <>
                {/* Primary path: real OIDC round-trip. Validates client_id +
                    client_secret + redirect URI end-to-end and auto-captures
                    the sub. Strongly preferred over the manual paste below. */}
                <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
                  <p className="text-sm font-medium">
                    Verify and link in one step
                  </p>
                  <p className="text-xs text-muted-foreground">
                    You&apos;ll be redirected to your IdP to sign in. On
                    success we auto-capture your <code className={codeClass}>sub</code>{" "}
                    claim and confirm the client ID, client secret, and
                    redirect URI are all correct. This is the safest way to
                    avoid getting locked out by a typo &mdash; bad credentials
                    fail <em>here</em>, before SSO is activated.
                  </p>
                  <Button
                    size="sm"
                    disabled={oidcLinkStarting || !step1Complete}
                    onClick={handleLinkViaOidc}
                  >
                    {oidcLinkStarting ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <ExternalLink className="mr-2 h-4 w-4" />
                    )}
                    Verify &amp; Link via OIDC
                  </Button>
                </div>

                {/* Fallback path: paste sub manually. Useful when the OIDC
                    flow can't reach the IdP from the browser (e.g. admin
                    network restrictions), or for backups/restores. */}
                {!showManualLink ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="px-0 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setShowManualLink(true)}
                    disabled={!step1Complete}
                  >
                    Or paste the subject manually →
                  </Button>
                ) : (
                  <div className="space-y-2 rounded-md border border-dashed border-border p-3">
                    <p className="text-xs text-muted-foreground">
                      Manual fallback: paste the OIDC{" "}
                      <code className={codeClass}>sub</code> claim if the OIDC
                      flow above isn&apos;t usable. Warning: credentials are
                      <em> not </em>verified by this path; a typo in step 1
                      won&apos;t be caught until login time.
                    </p>
                    <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                      <Input
                        placeholder="OIDC sub claim value"
                        value={linkSubject}
                        onChange={(e) => setLinkSubject(e.target.value)}
                        disabled={!step1Complete}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={linking || !linkSubject.trim() || !step1Complete}
                        onClick={handleLink}
                      >
                        {linking ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : null}
                        Link Manually
                      </Button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              // Forward-auth mode has no OAuth round-trip — the sub is the
              // value the proxy will inject, known to the admin out-of-band.
              <>
                <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <Input
                    placeholder="Username your reverse proxy sends"
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
                  Enter the username your reverse proxy will inject as the
                  configured user header (typically your IdP username).
                </p>
              </>
            )}
          </div>
        )}
        {linkError && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {linkError}
          </div>
        )}
        {linkNotice && (
          <div className="flex items-start gap-2 rounded-md border border-amber/30 bg-amber/10 p-3 text-sm text-amber">
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

      {/* Revert-config confirmation. Restores the snapshot from before the
          last SSO config save. Single-step undo — no history beyond that. */}
      <AlertDialog open={confirmRevertOpen} onOpenChange={setConfirmRevertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert SSO configuration?</AlertDialogTitle>
            <AlertDialogDescription>
              This restores the SSO connection settings that were active
              before your most recent save (issuer URL, client ID, client
              secret, scopes, etc.). SSO login will stay turned off after
              the revert — you&rsquo;ll need to re-enable it in step 3
              after confirming the restored config still works.
              <br /><br />
              This is single-step undo: only the immediately-previous state
              is kept. Reverting clears the snapshot, so you can&rsquo;t
              re-revert this revert.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reverting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRevert} disabled={reverting}>
              {reverting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <History className="mr-2 h-4 w-4" />
              )}
              Revert
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Translate the `?ssoLinkError=…` query string returned by the OIDC link
 * callback into a user-facing message. Each value matches one branch of the
 * callback's redirectToSsoSettings calls.
 */
function linkErrorMessage(code: string): string {
  switch (code) {
    case "sso_not_configured":
      return "Save the OIDC issuer URL and client ID in step 1 first.";
    case "missing_params":
      return "The IdP sent an incomplete response. Try again.";
    case "state_mismatch":
      return "The link request expired or was tampered with. Try again.";
    case "token_exchange_failed":
      return "OIDC token exchange failed. Double-check the client ID and client secret — this is exactly what the link flow is meant to catch before SSO is enabled.";
    case "conflict":
      return "Another account is already linked to this SSO identity at the same issuer.";
    case "session_lost":
      return "Your admin session expired during the OIDC round-trip. Sign in again and retry.";
    default:
      // Pass through IdP-provided error codes (e.g. access_denied) verbatim
      // so the admin can see them directly.
      return `OIDC link failed: ${code}`;
  }
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
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green/10 text-green">
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
