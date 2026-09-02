"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Ban,
  Check,
  Copy,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Plus,
  Terminal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDate, formatRelativeDate } from "@/lib/format";
import { SettingsSection } from "../components";
import type { ApiKeySummary } from "../types";

export type ApiKeyScope = ApiKeySummary["scope"];

/** Expiry choices offered in the create dialog. Resolved to an ISO date in page.tsx. */
export type ApiKeyExpiryPreset = "never" | "30d" | "90d" | "1y";

export interface ApiKeyCreateForm {
  name: string;
  scope: ApiKeyScope;
  expiry: ApiKeyExpiryPreset;
}

/** Snippet ids handed to `onCopySnippet`, so the copied tick lands on one button. */
const SNIPPET_SECRET = "secret";
const SNIPPET_HEADER = "curl-header";
const SNIPPET_BEARER = "curl-bearer";

const CURL_HEADER = `curl -H "X-Api-Key: lbr_..." https://your-librariarr/api/v1/library/movies`;
const CURL_BEARER = `curl -H "Authorization: Bearer lbr_..." https://your-librariarr/api/v1/stats`;

const SCOPE_LABELS: Record<ApiKeyScope, string> = {
  READ_ONLY: "Read only",
  READ_WRITE: "Read and write",
};

const SCOPE_HELP: Record<ApiKeyScope, string> = {
  READ_ONLY:
    "Browse the library, stats, lifecycle matches and pending actions. Every write endpoint is rejected with 403.",
  READ_WRITE:
    "Everything a read-only key can do, plus triggering syncs, running lifecycle detection or execution, and adding exceptions.",
};

const EXPIRY_LABELS: Record<ApiKeyExpiryPreset, string> = {
  never: "Never",
  "30d": "30 days",
  "90d": "90 days",
  "1y": "1 year",
};

// Expired and revoked keys must not read like a live credential, so both get a
// muted-but-warning treatment rather than the green used for an active key.
const STATUS_STYLES: Record<ApiKeySummary["status"], { label: string; className: string }> = {
  active: { label: "Active", className: "bg-green-500/20 text-green-400 shadow-[0_0_8px] shadow-green-500/15" },
  expired: { label: "Expired", className: "bg-amber-500/20 text-amber-400" },
  revoked: { label: "Revoked", className: "bg-red-500/20 text-red-400" },
};

export interface ApiTabProps {
  apiKeys: ApiKeySummary[];
  apiKeysLoading: boolean;
  /** Create dialog. */
  apiKeyDialogOpen: boolean;
  apiKeyForm: ApiKeyCreateForm;
  creatingApiKey: boolean;
  onApiKeyDialogOpenChange: (open: boolean) => void;
  onApiKeyFormChange: (patch: Partial<ApiKeyCreateForm>) => void;
  onCreateApiKey: () => void;
  /** The raw secret from the last create — shown once, then dropped from state. */
  revealedApiKey: string | null;
  onDismissRevealedApiKey: () => void;
  /** Id of the snippet whose copy button should show a tick, or null. */
  copiedSnippet: string | null;
  onCopySnippet: (id: string, text: string) => void;
  /** Destructive confirmations. */
  revokeApiKeyTarget: ApiKeySummary | null;
  deleteApiKeyTarget: ApiKeySummary | null;
  revokingApiKeyId: string | null;
  deletingApiKeyId: string | null;
  onRevokeApiKeyTargetChange: (key: ApiKeySummary | null) => void;
  onDeleteApiKeyTargetChange: (key: ApiKeySummary | null) => void;
  onRevokeApiKey: () => void;
  onDeleteApiKey: () => void;
}

function CodeSnippet({
  id,
  text,
  label,
  copied,
  onCopy,
}: {
  id: string;
  text: string;
  label: string;
  copied: boolean;
  onCopy: (id: string, text: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-[10px] border border-border bg-muted/40 px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs text-foreground/90">
        {text}
      </code>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        onClick={() => onCopy(id, text)}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

export function ApiTab({
  apiKeys,
  apiKeysLoading,
  apiKeyDialogOpen,
  apiKeyForm,
  creatingApiKey,
  onApiKeyDialogOpenChange,
  onApiKeyFormChange,
  onCreateApiKey,
  revealedApiKey,
  onDismissRevealedApiKey,
  copiedSnippet,
  onCopySnippet,
  revokeApiKeyTarget,
  deleteApiKeyTarget,
  revokingApiKeyId,
  deletingApiKeyId,
  onRevokeApiKeyTargetChange,
  onDeleteApiKeyTargetChange,
  onRevokeApiKey,
  onDeleteApiKey,
}: ApiTabProps) {
  const createDisabled = creatingApiKey || !apiKeyForm.name.trim();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">API Access</h2>
        <p className="text-sm text-muted-foreground">
          Integrations authenticate against{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">/api/v1</code> with an API key instead of a
          browser session. A key is shown <strong>once</strong>, at creation — Librariarr stores only a hash of
          it, so a lost key has to be replaced rather than looked up.
        </p>
      </div>

      <SettingsSection
        icon={KeyRound}
        title="API keys"
        description="Give each integration its own key so you can revoke one without disturbing the others."
        contentClassName="p-0"
        action={
          <Button size="sm" onClick={() => onApiKeyDialogOpenChange(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Create API key
          </Button>
        }
      >
        {apiKeysLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading keys…
          </div>
        ) : apiKeys.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-5 py-14 text-center">
            <div className="rounded-full bg-muted p-4">
              <KeyRound className="h-8 w-8 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-base font-medium">No API keys yet</p>
              <p className="text-sm text-muted-foreground">
                Create one to let a script, dashboard, or automation read your library over the API.
              </p>
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-5">Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-10 px-5" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiKeys.map((key) => {
                const status = STATUS_STYLES[key.status];
                const busy = revokingApiKeyId === key.id || deletingApiKeyId === key.id;
                return (
                  <TableRow key={key.id} className={cn(key.status !== "active" && "opacity-70")}>
                    <TableCell className="px-5 font-medium">{key.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{key.prefix}…</TableCell>
                    <TableCell>
                      <Badge variant={key.scope === "READ_WRITE" ? "secondary" : "outline"}>
                        {SCOPE_LABELS[key.scope]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="ghost" className={status.className}>
                        {status.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {key.lastUsedAt ? formatRelativeDate(key.lastUsedAt) : "Never"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(key.expiresAt, "Never")}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(key.createdAt)}</TableCell>
                    <TableCell className="px-5">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`Actions for ${key.name}`}>
                            {busy ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <MoreHorizontal className="h-4 w-4" />
                            )}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {key.status === "active" && (
                            <>
                              <DropdownMenuItem onClick={() => onRevokeApiKeyTargetChange(key)}>
                                <Ban className="h-4 w-4" />
                                Revoke
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                            </>
                          )}
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => onDeleteApiKeyTargetChange(key)}
                          >
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SettingsSection>

      <SettingsSection
        icon={Terminal}
        title="Using your key"
        description="Send the key on every request as either header. A key in the query string is not accepted — URLs end up in access logs."
        contentClassName="space-y-3"
      >
        <CodeSnippet
          id={SNIPPET_HEADER}
          text={CURL_HEADER}
          label="X-Api-Key example"
          copied={copiedSnippet === SNIPPET_HEADER}
          onCopy={onCopySnippet}
        />
        <CodeSnippet
          id={SNIPPET_BEARER}
          text={CURL_BEARER}
          label="Bearer token example"
          copied={copiedSnippet === SNIPPET_BEARER}
          onCopy={onCopySnippet}
        />
        <p className="text-[13px] text-muted-foreground">
          <code className="rounded bg-muted px-1 py-0.5 text-xs">GET /api/v1/health</code> is the one endpoint
          that needs no key — use it to check the server is reachable before configuring an integration.
        </p>
      </SettingsSection>

      {/* ─── Create dialog ─── */}
      <Dialog open={apiKeyDialogOpen} onOpenChange={onApiKeyDialogOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              The key is generated on the server and displayed once. Copy it somewhere safe before closing.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="api-key-name">Name</Label>
              <Input
                id="api-key-name"
                placeholder="e.g. Home Assistant, Grafana, backup script"
                value={apiKeyForm.name}
                onChange={(e) => onApiKeyFormChange({ name: e.target.value })}
              />
              <p className="text-[13px] text-muted-foreground">
                Identifies the key in this list and in the system log. Must be unique.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="api-key-scope">Scope</Label>
              <Select
                value={apiKeyForm.scope}
                onValueChange={(v) => onApiKeyFormChange({ scope: v as ApiKeyScope })}
              >
                <SelectTrigger id="api-key-scope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="READ_ONLY">{SCOPE_LABELS.READ_ONLY}</SelectItem>
                  <SelectItem value="READ_WRITE">{SCOPE_LABELS.READ_WRITE}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[13px] text-muted-foreground">{SCOPE_HELP[apiKeyForm.scope]}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="api-key-expiry">Expiration</Label>
              <Select
                value={apiKeyForm.expiry}
                onValueChange={(v) => onApiKeyFormChange({ expiry: v as ApiKeyExpiryPreset })}
              >
                <SelectTrigger id="api-key-expiry" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">{EXPIRY_LABELS.never}</SelectItem>
                  <SelectItem value="30d">{EXPIRY_LABELS["30d"]}</SelectItem>
                  <SelectItem value="90d">{EXPIRY_LABELS["90d"]}</SelectItem>
                  <SelectItem value="1y">{EXPIRY_LABELS["1y"]}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[13px] text-muted-foreground">
                An expired key stops authenticating on its own — useful for a key you hand to something
                temporary.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onApiKeyDialogOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={onCreateApiKey} disabled={createDisabled}>
              {creatingApiKey ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Create key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── One-time reveal ─── */}
      <Dialog open={revealedApiKey !== null}>
        <DialogContent
          className="sm:max-w-lg"
          showCloseButton={false}
          // Only the explicit button dismisses this: the secret cannot be
          // recovered, so a stray click on the overlay or Esc must not lose it.
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Copy your API key</DialogTitle>
            <DialogDescription>
              This is the only time the key is shown. Store it in your integration now.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-start gap-2 rounded-[10px] border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[13px] text-amber-300">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Librariarr stores only a hash of this key and cannot show it again. If you lose it, delete the key
              and create a new one.
            </span>
          </div>

          {revealedApiKey && (
            <CodeSnippet
              id={SNIPPET_SECRET}
              text={revealedApiKey}
              label="API key"
              copied={copiedSnippet === SNIPPET_SECRET}
              onCopy={onCopySnippet}
            />
          )}

          <DialogFooter>
            <Button onClick={onDismissRevealedApiKey}>I&apos;ve saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Revoke confirmation ─── */}
      <AlertDialog
        open={revokeApiKeyTarget !== null}
        onOpenChange={(open) => !open && onRevokeApiKeyTargetChange(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revokeApiKeyTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The key stops working immediately — the next request made with it is rejected. Revoking cannot be
              undone; a replacement has to be created. The row stays in this list so you keep the audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onRevokeApiKey}>
              {revokingApiKeyId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Revoke key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Delete confirmation ─── */}
      <AlertDialog
        open={deleteApiKeyTarget !== null}
        onOpenChange={(open) => !open && onDeleteApiKeyTargetChange(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteApiKeyTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This erases the record entirely, including when the key was created and last used. If the key is
              still active it also stops working. Revoke instead if you want to keep the audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDeleteApiKey}>
              {deletingApiKeyId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Delete key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
