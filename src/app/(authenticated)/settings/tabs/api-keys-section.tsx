"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Copy,
  Download,
  Eye,
  FileJson,
  KeySquare,
  Loader2,
  Plus,
  ShieldCheck,
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
import { apiKeyNameProblem } from "@/lib/api-keys/name-rules";
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
import { ReauthPanel } from "@/components/reauth-panel";
import { reauthMethodsOf, type ReauthMethod } from "@/lib/auth/reauth-client";
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

// The latest custom date offered. The end of 9999-12-31 is already in the year
// 10000 in UTC for anyone west of Greenwich, and a five-digit year is not an
// ISO 8601 date-time the server accepts.
const MAX_CUSTOM_DATE = "9998-12-31";

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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(customDate) || customDate > MAX_CUSTOM_DATE) return undefined;
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

async function fetchApiKeys(): Promise<ApiKeyRow[]> {
  const res = await fetch("/api/settings/api-keys", { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return ((await res.json()) as { apiKeys: ApiKeyRow[] }).apiKeys;
}

function isExpired(key: ApiKeyRow): boolean {
  return !!key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now();
}


export function ApiKeysSection({ hasPassword }: { hasPassword: boolean }) {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // Bumped on every open, so each create starts from a fresh dialog — even one
  // reopened before the previous close animation finished.
  const [createSession, setCreateSession] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Kept once the dialog closes, so its title doesn't empty while it fades.
  const [deleteTarget, setDeleteTarget] = useState<ApiKeyRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  // Set when the row whose Delete button opened the dialog is gone, so focus
  // has somewhere to go other than the page body.
  const refocusCreate = useRef(false);
  const loadSeq = useRef(0);

  // Only the newest request may write the list: a Retry and the refresh after
  // a create can overlap, and an older answer must not replace a newer one.
  const load = async () => {
    loadSeq.current += 1;
    const seq = loadSeq.current;
    try {
      const apiKeys = await fetchApiKeys();
      if (seq !== loadSeq.current) return;
      setKeys(apiKeys);
      setLoadError(null);
    } catch {
      if (seq === loadSeq.current) setLoadError("Failed to load API keys");
    }
  };

  useEffect(() => {
    loadSeq.current += 1;
    const seq = loadSeq.current;
    fetchApiKeys().then(
      (apiKeys) => {
        if (seq === loadSeq.current) setKeys(apiKeys);
      },
      () => {
        if (seq === loadSeq.current) setLoadError("Failed to load API keys");
      },
    );
    return () => {
      // Nothing still in flight may land after unmount.
      loadSeq.current += 1;
    };
  }, []);

  const retry = async () => {
    setRetrying(true);
    try {
      await load();
    } finally {
      setRetrying(false);
    }
  };

  const openCreate = () => {
    setCreateSession((n) => n + 1);
    setCreateOpen(true);
  };

  const openDelete = (key: ApiKeyRow) => {
    setDeleteTarget(key);
    setDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleting(true);
    try {
      const res = await fetch(`/api/settings/api-keys/${encodeURIComponent(target.id)}`, {
        method: "DELETE",
      });
      if (res.status === 404) {
        // Most likely deleted from another tab. Re-read the list rather than
        // assume, so it shows what the server actually has.
        toast.info(`API key "${target.name}" was already deleted`);
        refocusCreate.current = true;
        setDeleteOpen(false);
        void load();
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error("Couldn't delete API key", { description: data?.error });
        return;
      }
      setKeys((prev) => prev?.filter((k) => k.id !== target.id) ?? prev);
      // Also supersedes a load still in flight from before the delete, which
      // would otherwise put the key back.
      void load();
      toast.success(`API key "${target.name}" deleted`, {
        description: "Anything using it lost access immediately.",
      });
      refocusCreate.current = true;
      setDeleteOpen(false);
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
        <div className="flex flex-wrap items-center gap-2">
          {/* Swagger UI over the document built per request from the route table. */}
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings/api-docs">
              <FileJson className="mr-1.5 h-4 w-4" />
              API docs
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href="/api/settings/api-keys/openapi?download=1" download="librariarr-openapi.json">
              <Download className="mr-1.5 h-4 w-4" />
              Download
            </a>
          </Button>
          <Button ref={createButtonRef} size="sm" onClick={openCreate} disabled={keys === null && !loadError}>
            <Plus className="mr-1.5 h-4 w-4" />
            Create API Key
          </Button>
        </div>
      }
      contentClassName="space-y-3"
    >
      {loadError && (
        <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{loadError}</span>
          <Button variant="outline" size="sm" className="ml-auto" onClick={retry} disabled={retrying}>
            {retrying && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
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
            <ApiKeyListItem key={key.id} apiKey={key} onDelete={() => openDelete(key)} />
          ))}
        </ul>
      )}

      <CreateApiKeyDialog
        key={createSession}
        open={createOpen}
        onOpenChange={setCreateOpen}
        existingNames={keys?.map((k) => k.name) ?? []}
        hasPassword={hasPassword}
        returnFocusTo={createButtonRef}
        onCreated={(created) => {
          // Shown at once; the refresh then fills in anything this list was
          // missing (it may never have loaded).
          setKeys((prev) => (prev ? [created, ...prev.filter((k) => k.id !== created.id)] : prev));
          void load();
        }}
        onListStale={() => void load()}
      />

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && deleting) return;
          setDeleteOpen(open);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            if (!refocusCreate.current) return;
            refocusCreate.current = false;
            e.preventDefault();
            createButtonRef.current?.focus();
          }}
        >
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
          {apiKey.lastUsedAt ? (
            <>
              Last used {formatRelativeDate(apiKey.lastUsedAt)}
              {apiKey.lastUsedIp && (
                <>
                  {" from "}
                  <span
                    className="cursor-help underline decoration-dotted underline-offset-2"
                    title="The address your reverse proxy reported for the last request. Without a trusted proxy in front of Librariarr this is whatever the client claimed — see TRUST_PROXY_HEADERS."
                  >
                    {apiKey.lastUsedIp}
                  </span>
                </>
              )}
            </>
          ) : (
            "Never used"
          )}
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

const ACCESS_OPTIONS = [
  {
    value: "read",
    icon: Eye,
    title: "Read-only",
    description: "Read everything the API exposes. Cannot change anything.",
  },
  {
    value: "custom",
    icon: SlidersHorizontal,
    title: "Custom scopes",
    description: "Pick exactly what the key may read and do.",
  },
] as const;

type AccessChoice = (typeof ACCESS_OPTIONS)[number]["value"];

function CreateApiKeyDialog({
  open,
  onOpenChange,
  existingNames,
  hasPassword,
  returnFocusTo,
  onCreated,
  onListStale,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingNames: string[];
  /** The account has a local password, which creating a key must confirm. */
  hasPassword: boolean;
  /** Focused once the dialog has closed. */
  returnFocusTo: RefObject<HTMLButtonElement | null>;
  onCreated: (apiKey: ApiKeyRow) => void;
  /** The list may be missing a key the server has — re-read it. */
  onListStale: () => void;
}) {
  const [name, setName] = useState("");
  const [access, setAccess] = useState<AccessChoice>("read");
  const [selected, setSelected] = useState<Set<ApiScope>>(new Set());
  const [expiry, setExpiry] = useState<ExpiryChoice>("90");
  const [customDate, setCustomDate] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the server wants a recent sign-in (no local password): the ways
  // this account can confirm it in place, instead of signing out and back in.
  const [reauthMethods, setReauthMethods] = useState<ReauthMethod[] | null>(null);
  // The plaintext key, held only while the reveal step is on screen.
  const [revealedKey, setRevealedKey] = useState<{ key: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const keyInputRef = useRef<HTMLInputElement>(null);
  // The key on screen now, for a copy that finishes after the dialog closed.
  const revealedKeyRef = useRef<string | null>(null);
  const accessRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Leaving the page while the key is on screen loses it for good, so ask.
  useEffect(() => {
    if (!revealedKey) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [revealedKey]);

  const reset = () => {
    setName("");
    setAccess("read");
    setSelected(new Set());
    setExpiry("90");
    setCustomDate("");
    setCurrentPassword("");
    setPasswordError(null);
    setSaving(false);
    setError(null);
    setReauthMethods(null);
    setRevealedKey(null);
    revealedKeyRef.current = null;
    setCopied(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (saving) return;
    // The form is reset once the close animation has finished (see
    // onCloseAutoFocus) — resetting here swapped the content mid-fade.
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
  const nameProblem = apiKeyNameProblem(trimmedName);
  const duplicateName = existingNames.includes(trimmedName);
  // Nothing typed yet is not an error; Create simply stays disabled.
  const nameError = duplicateName
    ? "A key with this name already exists."
    : name.length > 0
      ? nameProblem
      : null;
  const expiresAt = resolveExpiry(expiry, customDate);
  const canCreate =
    nameProblem === null &&
    !duplicateName &&
    scopes.length > 0 &&
    expiresAt !== undefined &&
    (!hasPassword || currentPassword.length > 0) &&
    !saving;

  const toggleScope = (scope: ApiScope, checked: boolean) => {
    setError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(scope);
      else next.delete(scope);
      return next;
    });
  };

  const selectAccess = (value: AccessChoice) => {
    setError(null);
    setAccess(value);
  };

  // Arrow keys move the choice, as in any radio group; Tab enters and leaves
  // the group at the checked option.
  const handleAccessKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = (index + step + ACCESS_OPTIONS.length) % ACCESS_OPTIONS.length;
    selectAccess(ACCESS_OPTIONS[next].value);
    accessRefs.current[next]?.focus();
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    // Resolved now rather than at the last render: the dialog may have sat
    // open past the end of a custom date, or for a while on "7 days".
    const expiresAtNow = resolveExpiry(expiry, customDate);
    if (expiresAtNow === undefined) {
      setError("That expiration date has passed — pick another.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          scopes,
          expiresAt: expiresAtNow,
          ...(hasPassword && { currentPassword }),
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && typeof data?.key === "string" && data?.apiKey) {
        const created = data.apiKey as ApiKeyRow;
        revealedKeyRef.current = data.key;
        setRevealedKey({ key: data.key, name: created.name });
        onCreated(created);
        return;
      }
      if (res.ok) {
        setError(
          "The key was created, but its value could not be read. Delete it from the list and create another.",
        );
        onListStale();
        return;
      }
      // A clash with a key this list has not seen (made in another tab).
      if (res.status === 409) onListStale();
      if (data?.code === "password_incorrect") {
        setCurrentPassword("");
        setPasswordError("That password is not correct.");
        return;
      }
      const methods = reauthMethodsOf(data);
      if (methods) {
        // Confirmed in place below, then the key is created.
        setReauthMethods(methods);
        return;
      }
      if (data?.code === "password_required") {
        // A password was set since this page loaded.
        setError("This account now has a password. Reload the page, then enter it here to create the key.");
        return;
      }
      setError(saveErrorMessage(data, "Failed to create API key"));
    } catch {
      setError(
        "Network error. If the key was created anyway it will appear in the list — delete it and create another, since its value cannot be shown again.",
      );
      onListStale();
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!revealedKey) return;
    const value = revealedKey.key;
    let ok = false;
    try {
      // Only available in a secure context (HTTPS or localhost).
      await navigator.clipboard.writeText(value);
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
    // The dialog closed (and dropped the key) while the copy was pending.
    if (revealedKeyRef.current !== value) return;
    if (ok) {
      setCopied(true);
      toast.success("API key copied");
    } else {
      toast.error("Couldn't copy automatically", {
        description: "The key is selected in the field — copy it from there.",
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
        // Runs once the close animation has finished: drop the key from memory
        // and hand focus back to the button that opened the dialog.
        onCloseAutoFocus={(e) => {
          reset();
          const target = returnFocusTo.current;
          if (target) {
            e.preventDefault();
            target.focus();
          }
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
                  autoComplete="off"
                  value={name}
                  onChange={(e) => {
                    setError(null);
                    setName(e.target.value);
                  }}
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={nameError ? "api-key-name-error" : undefined}
                />
                {nameError && (
                  <p id="api-key-name-error" className="text-xs text-destructive">
                    {nameError}
                  </p>
                )}
              </div>

              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium">Access</legend>
                <div role="radiogroup" aria-label="Access" className="grid gap-2 sm:grid-cols-2">
                  {ACCESS_OPTIONS.map((option, index) => (
                    <AccessOption
                      key={option.value}
                      ref={(el) => {
                        accessRefs.current[index] = el;
                      }}
                      checked={access === option.value}
                      onSelect={() => selectAccess(option.value)}
                      onKeyDown={(e) => handleAccessKeyDown(e, index)}
                      icon={option.icon}
                      title={option.title}
                      description={option.description}
                    />
                  ))}
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
                  <Select
                    value={expiry}
                    onValueChange={(v) => {
                      setError(null);
                      setExpiry(v as ExpiryChoice);
                    }}
                  >
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
                      max={MAX_CUSTOM_DATE}
                      value={customDate}
                      onChange={(e) => {
                        setError(null);
                        setCustomDate(e.target.value);
                      }}
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
                    <p className="text-xs text-muted-foreground">
                      {customDate
                        ? "Pick a date from today onward, before the year 9999."
                        : "Pick the last day the key should work."}
                    </p>
                  )
                )}
              </div>

              {hasPassword && (
                <div className="space-y-1">
                  <Label htmlFor="api-key-current-password">Current password</Label>
                  <Input
                    id="api-key-current-password"
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => {
                      setPasswordError(null);
                      setError(null);
                      setCurrentPassword(e.target.value);
                    }}
                    aria-invalid={passwordError ? true : undefined}
                    aria-describedby={passwordError ? "api-key-current-password-error" : "api-key-current-password-hint"}
                  />
                  {passwordError ? (
                    <p id="api-key-current-password-error" className="text-xs text-destructive">
                      {passwordError}
                    </p>
                  ) : (
                    <p id="api-key-current-password-hint" className="text-xs text-muted-foreground">
                      A key keeps working after you sign out, so creating one confirms it is you.
                    </p>
                  )}
                </div>
              )}

              {reauthMethods && (
                <div role="alert" className="space-y-3 rounded-md border border-amber/40 bg-amber/10 p-3 text-sm">
                  <p className="flex items-start gap-2">
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
                    <span>
                      <span className="font-medium">Confirm it&rsquo;s you.</span> A key keeps working after
                      you sign out, so creating one needs a sign-in from the last 15 minutes.
                      {reauthMethods.length > 0 && " The key is created as soon as you confirm."}
                    </span>
                  </p>
                  <ReauthPanel
                    methods={reauthMethods}
                    disabled={saving}
                    onConfirmed={async () => {
                      setReauthMethods(null);
                      // Closed while the sign-in was under way: create nothing.
                      if (open) await handleCreate();
                    }}
                  />
                </div>
              )}

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
  ref,
  checked,
  onSelect,
  onKeyDown,
  icon: Icon,
  title,
  description,
}: {
  ref: (el: HTMLButtonElement | null) => void;
  checked: boolean;
  onSelect: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={checked}
      // Roving tab stop: only the checked option is in the tab order.
      tabIndex={checked ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
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
