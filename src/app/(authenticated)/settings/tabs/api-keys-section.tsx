"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Copy,
  Eye,
  KeySquare,
  Loader2,
  Plus,
  SlidersHorizontal,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { cn } from "@/lib/utils";
import { formatDate, formatRelativeDate } from "@/lib/format";
import {
  API_SCOPE_GROUPS,
  API_SCOPE_INFO,
  READ_ONLY_SCOPES,
  hasDestructiveScope,
  isApiScope,
  isReadOnlyScopeSet,
  normalizeScopes,
  type ApiScope,
} from "@/lib/api-keys/scopes";
import { SettingsSection } from "../components";

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
}

const EXPIRY_OPTIONS = [
  { value: "7", label: "7 days", days: 7 },
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "365", label: "1 year", days: 365 },
  { value: "custom", label: "Custom date" },
  { value: "never", label: "Never expires" },
] as const;

type ExpiryChoice = (typeof EXPIRY_OPTIONS)[number]["value"];

const DAY_MS = 24 * 60 * 60 * 1000;

const codeClass = "font-mono text-[0.85em] rounded bg-muted/60 px-1 py-0.5";

/** `YYYY-MM-DD` in local time — the value format of `<input type="date">`. */
function localDateString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The expiry to send: an ISO timestamp, `null` for never, or `undefined` when
 * the choice is incomplete or not in the future. A custom date runs to the end
 * of that day in the viewer's time zone.
 */
function resolveExpiry(choice: ExpiryChoice, customDate: string): string | null | undefined {
  if (choice === "never") return null;
  if (choice === "custom") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(customDate)) return undefined;
    const end = new Date(`${customDate}T23:59:59`);
    if (Number.isNaN(end.getTime()) || end.getTime() <= Date.now()) return undefined;
    return end.toISOString();
  }
  const option = EXPIRY_OPTIONS.find((o) => o.value === choice);
  const days = option && "days" in option ? option.days : 90;
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

/** First validation detail when there is one — the bare error names no field. */
function saveErrorMessage(data: { error?: string; details?: unknown } | null, fallback: string): string {
  const first = Array.isArray(data?.details) ? data.details[0] : undefined;
  const error = data?.error || fallback;
  return typeof first === "string" ? `${error} — ${first}` : error;
}

function isExpired(key: ApiKeyRow): boolean {
  return !!key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now();
}

export function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ApiKeyRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    try {
      const res = await fetch("/api/settings/api-keys", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { apiKeys: ApiKeyRow[] };
      setKeys(data.apiKeys);
      setLoadError(null);
    } catch {
      setLoadError("Failed to load API keys");
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/api-keys", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { apiKeys: ApiKeyRow[] };
        if (!cancelled) setKeys(data.apiKeys);
      } catch {
        if (!cancelled) setLoadError("Failed to load API keys");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/settings/api-keys/${encodeURIComponent(deleteTarget.id)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => null);
        toast.error("Couldn't delete API key", { description: data?.error });
        return;
      }
      setKeys((prev) => prev?.filter((k) => k.id !== deleteTarget.id) ?? prev);
      toast.success(`API key "${deleteTarget.name}" deleted`, {
        description: "Anything using it lost access immediately.",
      });
      setDeleteTarget(null);
    } catch {
      toast.error("Couldn't delete API key");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <SettingsSection
      icon={KeySquare}
      title="API Keys"
      description={
        <>
          Let other applications use Librariarr&rsquo;s API at{" "}
          <code className={codeClass}>/api/v1</code>. A key is shown once, when
          it is created, and can be deleted at any time.
        </>
      }
      action={
        <Button size="sm" onClick={() => setCreateOpen(true)} disabled={keys === null && !loadError}>
          <Plus className="mr-1.5 h-4 w-4" />
          Create API Key
        </Button>
      }
      contentClassName="space-y-3"
    >
      {loadError && (
        <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{loadError}</span>
          <Button variant="outline" size="sm" className="ml-auto" onClick={load}>
            Retry
          </Button>
        </div>
      )}

      {keys === null && !loadError && (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {keys?.length === 0 && (
        <p className="py-2 text-sm text-muted-foreground">
          No API keys yet. Create one for each application that needs access, so
          you can revoke them one at a time.
        </p>
      )}

      {keys && keys.length > 0 && (
        <ul className="divide-y divide-border/60" aria-label="API keys">
          {keys.map((key) => (
            <ApiKeyListItem key={key.id} apiKey={key} onDelete={() => setDeleteTarget(key)} />
          ))}
        </ul>
      )}

      <CreateApiKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        existingNames={keys?.map((k) => k.name) ?? []}
        onCreated={(created) => setKeys((prev) => [created, ...(prev ?? [])])}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete API key &ldquo;{deleteTarget?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Any application using this key loses access immediately. This
              cannot be undone &mdash; to restore access, create a new key and
              give it to the application.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
            >
              {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              Delete Key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

function ApiKeyListItem({ apiKey, onDelete }: { apiKey: ApiKeyRow; onDelete: () => void }) {
  const expired = isExpired(apiKey);
  const readOnly = isReadOnlyScopeSet(apiKey.scopes);
  const destructive = hasDestructiveScope(apiKey.scopes);

  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{apiKey.name}</span>
          <code className={cn(codeClass, "text-muted-foreground")}>{apiKey.prefix}…</code>
          {expired ? (
            <Badge variant="destructive">Expired</Badge>
          ) : readOnly ? (
            <Badge variant="secondary">Read-only</Badge>
          ) : (
            <Badge variant="outline">Read &amp; write</Badge>
          )}
          {destructive && !expired && (
            <Badge variant="outline" className="border-destructive/40 text-destructive">
              Can delete media
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Created {formatDate(apiKey.createdAt)}
          {" · "}
          {apiKey.expiresAt
            ? `${expired ? "Expired" : "Expires"} ${formatDate(apiKey.expiresAt)}`
            : "Never expires"}
          {" · "}
          {apiKey.lastUsedAt
            ? `Last used ${formatRelativeDate(apiKey.lastUsedAt)}${apiKey.lastUsedIp ? ` from ${apiKey.lastUsedIp}` : ""}`
            : "Never used"}
        </p>
        <div className="flex flex-wrap gap-1">
          {apiKey.scopes.map((scope) => (
            <span
              key={scope}
              title={isApiScope(scope) ? API_SCOPE_INFO[scope].description : undefined}
              className={cn(
                "rounded border px-1.5 py-0.5 font-mono text-[11px]",
                isApiScope(scope) && API_SCOPE_INFO[scope].destructive
                  ? "border-destructive/40 text-destructive"
                  : "border-border text-muted-foreground",
              )}
            >
              {scope}
            </span>
          ))}
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0 text-destructive hover:text-destructive"
        onClick={onDelete}
        aria-label={`Delete API key ${apiKey.name}`}
      >
        <Trash2 className="mr-1.5 h-4 w-4" />
        Delete
      </Button>
    </li>
  );
}

function CreateApiKeyDialog({
  open,
  onOpenChange,
  existingNames,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingNames: string[];
  onCreated: (apiKey: ApiKeyRow) => void;
}) {
  const [name, setName] = useState("");
  const [access, setAccess] = useState<"read" | "custom">("read");
  const [selected, setSelected] = useState<Set<ApiScope>>(new Set());
  const [expiry, setExpiry] = useState<ExpiryChoice>("90");
  const [customDate, setCustomDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plaintext key, held only while the reveal step is on screen.
  const [revealedKey, setRevealedKey] = useState<{ key: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const keyInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setName("");
    setAccess("read");
    setSelected(new Set());
    setExpiry("90");
    setCustomDate("");
    setSaving(false);
    setError(null);
    setRevealedKey(null);
    setCopied(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (saving) return;
    // Closing drops the plaintext key from memory for good.
    if (!next) reset();
    onOpenChange(next);
  };

  const scopes: ApiScope[] = useMemo(
    () => (access === "read" ? [...READ_ONLY_SCOPES] : normalizeScopes([...selected])),
    [access, selected],
  );

  // Read scopes a selected write scope needs — shown checked and locked.
  const impliedByWrite = useMemo(() => {
    const implied = new Map<ApiScope, ApiScope>();
    for (const scope of selected) {
      for (const read of API_SCOPE_INFO[scope].implies ?? []) implied.set(read, scope);
    }
    return implied;
  }, [selected]);

  const trimmedName = name.trim();
  const duplicateName = existingNames.some((n) => n === trimmedName);
  const expiresAt = resolveExpiry(expiry, customDate);
  const canCreate =
    trimmedName.length > 0 &&
    trimmedName.length <= 64 &&
    !duplicateName &&
    scopes.length > 0 &&
    expiresAt !== undefined &&
    !saving;

  const toggleScope = (scope: ApiScope, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(scope);
      else next.delete(scope);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName, scopes, expiresAt }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.key) {
        setError(saveErrorMessage(data, "Failed to create API key"));
        return;
      }
      onCreated(data.apiKey as ApiKeyRow);
      setRevealedKey({ key: data.key as string, name: (data.apiKey as ApiKeyRow).name });
    } catch {
      setError("Network error — the key was not created");
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!revealedKey) return;
    let ok = false;
    try {
      // Only available in a secure context (HTTPS or localhost).
      await navigator.clipboard.writeText(revealedKey.key);
      ok = true;
    } catch {
      // Plain-HTTP LAN installs have no Clipboard API; fall back to copying
      // the selected text of the read-only field.
      const input = keyInputRef.current;
      if (input) {
        input.focus();
        input.select();
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
      }
    }
    if (ok) {
      setCopied(true);
      toast.success("API key copied");
    } else {
      toast.error("Couldn't copy automatically", {
        description: "The key is selected — press Ctrl+C (or ⌘C) to copy it.",
      });
    }
  };

  const today = localDateString(new Date());

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        // While the key is on screen, only Done / the close button may dismiss
        // the dialog — a stray click outside would lose it for good.
        onInteractOutside={(e) => {
          if (revealedKey || saving) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (revealedKey || saving) e.preventDefault();
        }}
      >
        {revealedKey ? (
          <>
            <DialogHeader>
              <DialogTitle>API key created</DialogTitle>
              <DialogDescription>
                &ldquo;{revealedKey.name}&rdquo; is ready. Give this key to the
                application that will use it.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-amber/30 bg-amber/10 p-3 text-sm text-amber"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">Copy the key now</p>
                  <p className="text-xs">
                    It will not be shown again &mdash; Librariarr stores only a
                    one-way hash of it. If you lose it, delete the key and
                    create a new one.
                  </p>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="api-key-value">API key</Label>
                <div className="flex gap-2">
                  <Input
                    id="api-key-value"
                    ref={keyInputRef}
                    readOnly
                    value={revealedKey.key}
                    className="font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button variant="outline" onClick={handleCopy} aria-label="Copy API key">
                    {copied ? <Check className="h-4 w-4 text-green" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  Send it in the <code className={codeClass}>Authorization</code>{" "}
                  header (or <code className={codeClass}>X-Api-Key</code>), never
                  in the URL:
                </p>
                <pre className="overflow-x-auto rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-relaxed">
                  {`curl -H "Authorization: Bearer <your key>" \\\n  ${typeof window !== "undefined" ? window.location.origin : ""}/api/v1/me`}
                </pre>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API Key</DialogTitle>
              <DialogDescription>
                Give each application its own key, with only the access it
                needs.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5">
              <div className="space-y-1">
                <Label htmlFor="api-key-name">Name</Label>
                <Input
                  id="api-key-name"
                  placeholder="e.g. Home Assistant"
                  maxLength={64}
                  autoComplete="off"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-invalid={duplicateName || undefined}
                />
                {duplicateName && (
                  <p className="text-xs text-destructive">A key with this name already exists.</p>
                )}
              </div>

              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium">Access</legend>
                <div role="radiogroup" aria-label="Access" className="grid gap-2 sm:grid-cols-2">
                  <AccessOption
                    checked={access === "read"}
                    onSelect={() => setAccess("read")}
                    icon={Eye}
                    title="Read-only"
                    description="Read everything the API exposes. Cannot change anything."
                  />
                  <AccessOption
                    checked={access === "custom"}
                    onSelect={() => setAccess("custom")}
                    icon={SlidersHorizontal}
                    title="Custom scopes"
                    description="Pick exactly what the key may read and do."
                  />
                </div>

                {access === "read" ? (
                  <p className="text-xs text-muted-foreground">
                    Grants{" "}
                    {READ_ONLY_SCOPES.map((s, i) => (
                      <span key={s}>
                        {i > 0 && ", "}
                        <code className={codeClass}>{s}</code>
                      </span>
                    ))}
                    .
                  </p>
                ) : (
                  <div className="space-y-3 rounded-md border border-border p-3">
                    {API_SCOPE_GROUPS.map((group) => (
                      <div key={group.label} className="space-y-2">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {group.label}
                        </p>
                        {group.scopes.map((scope) => {
                          const info = API_SCOPE_INFO[scope];
                          const requiredBy = impliedByWrite.get(scope);
                          const checked = selected.has(scope) || !!requiredBy;
                          const id = `api-scope-${scope.replace(":", "-")}`;
                          return (
                            <div key={scope} className="flex items-start gap-2.5">
                              <Checkbox
                                id={id}
                                className="mt-0.5"
                                checked={checked}
                                disabled={!!requiredBy}
                                onCheckedChange={(v) => toggleScope(scope, v === true)}
                              />
                              <div className="min-w-0 space-y-0.5">
                                <Label htmlFor={id} className="flex flex-wrap items-center gap-1.5 text-sm">
                                  {info.label}
                                  <code className={cn(codeClass, "font-normal text-muted-foreground")}>{scope}</code>
                                </Label>
                                <p
                                  className={cn(
                                    "text-xs",
                                    info.destructive ? "text-destructive" : "text-muted-foreground",
                                  )}
                                >
                                  {info.description}
                                  {requiredBy && ` Included with ${requiredBy}.`}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </fieldset>

              <div className="space-y-2">
                <Label htmlFor="api-key-expiry">Expiration</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Select value={expiry} onValueChange={(v) => setExpiry(v as ExpiryChoice)}>
                    <SelectTrigger id="api-key-expiry" className="sm:w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EXPIRY_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {expiry === "custom" && (
                    <Input
                      type="date"
                      aria-label="Expiration date"
                      min={today}
                      value={customDate}
                      onChange={(e) => setCustomDate(e.target.value)}
                      className="sm:w-48"
                    />
                  )}
                </div>
                {expiry === "never" ? (
                  <p className="flex items-start gap-1.5 text-xs text-amber">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    A key that never expires works until you delete it.
                  </p>
                ) : expiresAt ? (
                  <p className="text-xs text-muted-foreground">
                    Stops working after {new Date(expiresAt).toLocaleString()}.
                  </p>
                ) : (
                  expiry === "custom" && (
                    <p className="text-xs text-muted-foreground">Pick a date from today onward.</p>
                  )
                )}
              </div>

              {error && (
                <div role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={!canCreate}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeySquare className="mr-2 h-4 w-4" />}
                Create Key
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AccessOption({
  checked,
  onSelect,
  icon: Icon,
  title,
  description,
}: {
  checked: boolean;
  onSelect: () => void;
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-2.5 rounded-md border p-3 text-left transition-colors",
        checked ? "border-primary bg-primary/5" : "border-border hover:bg-accent/50",
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", checked ? "text-foreground" : "text-muted-foreground")} />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}
