"use client";

import { useEffect, useState } from "react";
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
  AlertCircle,
  CheckCircle,
  Globe,
  Loader2,
  Save,
  ShieldCheck,
  XCircle,
} from "lucide-react";

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
}

interface SsoLinkInfo {
  ssoSubject: string | null;
  ssoProvider: string | null;
  ssoEnabled: boolean;
}

export function SsoSection() {
  const [config, setConfig] = useState<SsoConfig | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [configRes, linkRes] = await Promise.all([
          fetch("/api/settings/sso"),
          fetch("/api/settings/sso/me"),
        ]);
        if (cancelled) return;
        if (configRes.ok) setConfig(await configRes.json());
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

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!config) {
    return null;
  }

  const updateField = <K extends keyof SsoConfig>(key: K, value: SsoConfig[K]) => {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSavedAt(null);
  };

  const handleSave = async () => {
    if (!config) return;
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/settings/sso", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to save");
        return;
      }
      setConfig(data);
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
        setTestResult({
          ok: true,
          message: `Discovery succeeded. Issuer: ${data.issuer}`,
        });
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
    setLinking(true);
    try {
      const res = await fetch("/api/settings/sso/link", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setLinkError(data.error || "Failed to unlink");
        return;
      }
      setLink(data);
    } catch {
      setLinkError("Network error");
    } finally {
      setLinking(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* SSO Account Linking */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" />
            SSO Account Linking
          </CardTitle>
          <CardDescription>
            Link an SSO identity (OIDC <code>sub</code> claim, or the username
            your reverse proxy will send as the user header) to this account.
            Linking is required before SSO login can be used.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {link.ssoSubject ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle className="h-4 w-4 text-green-500" />
                <span>
                  Linked to <strong>{link.ssoSubject}</strong>
                  {link.ssoProvider ? ` (${link.ssoProvider})` : ""}
                </span>
              </div>
              <Button variant="outline" size="sm" disabled={linking} onClick={handleUnlink}>
                {linking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
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
                />
                <Button disabled={linking || !linkSubject.trim()} onClick={handleLink}>
                  {linking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Link Identity
                </Button>
              </div>
            </div>
          )}
          {linkError && (
            <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {linkError}
            </div>
          )}
        </CardContent>
      </Card>

      {/* SSO Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4" />
            Single Sign-On (SSO)
          </CardTitle>
          <CardDescription>
            When enabled, the local username/password form is hidden on the
            login screen and users sign in via the configured identity provider.
            Plex login remains available if a Plex account is linked.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Enable SSO Login</p>
              <p className="text-xs text-muted-foreground">
                Requires an SSO identity to be linked to this account first.
              </p>
            </div>
            <Switch
              checked={config.ssoEnabled}
              onCheckedChange={(v) => updateField("ssoEnabled", v)}
            />
          </div>

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
                  <code>.well-known/openid-configuration</code> is served.
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
                      testResult.ok
                        ? "text-xs text-green-500"
                        : "text-xs text-destructive"
                    }
                  >
                    {testResult.message}
                  </span>
                )}
              </div>
              <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
                Register a confidential client at your IdP and set the redirect
                URI to{" "}
                <code>
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
              <div className="rounded-md bg-destructive/10 p-3 text-xs text-destructive">
                <strong>Security warning:</strong> Forward auth trusts the
                identity in these headers. Only enable it when Librariarr is
                reachable <em>exclusively</em> through your authenticating proxy
                — direct network access would let attackers spoof the headers.
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
              Settings saved
            </div>
          )}

          <Button size="sm" disabled={saving} onClick={handleSave}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save SSO Settings
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
