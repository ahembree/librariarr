"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ColorChip } from "@/components/color-chip";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Loader2,
  Plus,
  CheckCircle,
  Trash2,
  Save,
  Pencil,
  Boxes,
  Inbox,
  AlertCircle,
  Link2,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ArrInstance, SeerrInstance, TestResult } from "../types";

// ─── Type styling: matches the colored dots used on the media-detail Arr cards ───

interface IntegrationTypeStyle {
  text: string;
  dot: string;
  tile: string;
  border: string;
}

const INTEGRATION_TYPE_STYLES: Record<string, IntegrationTypeStyle> = {
  sonarr: {
    text: "text-sky-400",
    dot: "bg-sky-400 shadow-[0_0_6px] shadow-sky-400/60",
    tile: "bg-sky-500/10",
    border: "border-sky-500/30",
  },
  radarr: {
    text: "text-amber-400",
    dot: "bg-amber-400 shadow-[0_0_6px] shadow-amber-400/60",
    tile: "bg-amber-500/10",
    border: "border-amber-500/30",
  },
  lidarr: {
    text: "text-emerald-400",
    dot: "bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400/60",
    tile: "bg-emerald-500/10",
    border: "border-emerald-500/30",
  },
  seerr: {
    text: "text-violet-400",
    dot: "bg-violet-400 shadow-[0_0_6px] shadow-violet-400/60",
    tile: "bg-violet-500/10",
    border: "border-violet-500/30",
  },
};

// ─── Shared sub-components ───

function TestResultBadge({ result }: { result: TestResult }) {
  const Icon = result.ok ? CheckCircle : AlertCircle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        result.ok
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
          : "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {result.ok
        ? `Connected${result.appName ? ` to ${result.appName}` : ""}${result.version ? ` v${result.version}` : ""}`
        : `Failed: ${result.error}`}
    </span>
  );
}

function SectionHeader({
  title,
  icon: IconComp,
  style,
  count,
  disabledCount,
  showAddButton,
  onShowForm,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  style: IntegrationTypeStyle;
  count: number;
  disabledCount: number;
  showAddButton: boolean;
  onShowForm: () => void;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border", style.tile, style.border)}>
          <IconComp className={cn("h-4 w-4", style.text)} />
        </div>
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold leading-tight">{title}</h3>
          {count > 0 && (
            <p className="text-xs text-muted-foreground">
              {count} {count === 1 ? "instance" : "instances"}
              {disabledCount > 0 && ` · ${disabledCount} disabled`}
            </p>
          )}
        </div>
      </div>
      {showAddButton && (
        <Button variant="outline" size="sm" onClick={onShowForm} className="shrink-0">
          <Plus className="mr-2 h-4 w-4" />
          Add Instance
        </Button>
      )}
    </div>
  );
}

function EmptyState({
  title,
  icon: IconComp,
  style,
  description,
  onAdd,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  style: IntegrationTypeStyle;
  description: string;
  onAdd: () => void;
}) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center gap-4 py-10 text-center">
        <div className={cn("flex h-12 w-12 items-center justify-center rounded-xl border", style.tile, style.border)}>
          <IconComp className={cn("h-6 w-6", style.text)} />
        </div>
        <div className="space-y-1">
          <p className="font-medium">No {title} instances yet</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onAdd}>
          <Plus className="mr-2 h-4 w-4" />
          Add {title} Instance
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Props ───

interface ArrForm {
  name: string;
  url: string;
  apiKey: string;
  externalUrl: string;
}

interface SeerrForm {
  name: string;
  url: string;
  apiKey: string;
}

interface ArrEditing {
  id: string | null;
  form: ArrForm;
  saving: boolean;
  error: string;
  testing: boolean;
  testResult: TestResult | null;
}

interface SeerrEditing {
  id: string | null;
  form: SeerrForm;
  saving: boolean;
  error: string;
  testing: boolean;
  testResult: TestResult | null;
}

interface ArrSectionProps {
  instances: ArrInstance[];
  showForm: boolean;
  form: ArrForm;
  saving: boolean;
  error: string;
  testing: boolean;
  testResult: TestResult | null;
  editing: ArrEditing;
  onShowForm: (show: boolean) => void;
  onFormChange: (form: ArrForm) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onTest: () => void;
  onStartEdit: (instance: ArrInstance) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onEditFormChange: (form: ArrForm) => void;
  onEditTest: () => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
}

interface SeerrSectionProps {
  instances: SeerrInstance[];
  showForm: boolean;
  form: SeerrForm;
  saving: boolean;
  error: string;
  testing: boolean;
  testResult: TestResult | null;
  editing: SeerrEditing;
  onShowForm: (show: boolean) => void;
  onFormChange: (form: SeerrForm) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onTest: () => void;
  onStartEdit: (instance: SeerrInstance) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onEditFormChange: (form: SeerrForm) => void;
  onEditTest: () => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
}

export interface IntegrationsTabProps {
  sonarr: ArrSectionProps;
  radarr: ArrSectionProps;
  lidarr: ArrSectionProps;
  seerr: SeerrSectionProps;
}

// ─── Component ───

export function IntegrationsTab({
  sonarr,
  radarr,
  lidarr,
  seerr,
}: IntegrationsTabProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Connect Sonarr, Radarr, Lidarr, and Overseerr/Jellyseerr for lifecycle rule matching and request data.
        </p>
      </div>

      {/* Sonarr */}
      <ArrSection
        title="Sonarr"
        idPrefix="sonarr"
        // deepcode ignore HardcodedNonCryptoSecret: Placeholder string
        placeholder={{ name: "My Sonarr", url: "http://localhost:8989", apiKey: "API key from Sonarr settings" }}
        {...sonarr}
      />

      {/* Radarr */}
      <ArrSection
        title="Radarr"
        idPrefix="radarr"
        // deepcode ignore HardcodedNonCryptoSecret: Placeholder string
        placeholder={{ name: "My Radarr", url: "http://localhost:7878", apiKey: "API key from Radarr settings" }}
        {...radarr}
      />

      {/* Lidarr */}
      <ArrSection
        title="Lidarr"
        idPrefix="lidarr"
        // deepcode ignore HardcodedNonCryptoSecret: Placeholder string
        placeholder={{ name: "My Lidarr", url: "http://localhost:8686", apiKey: "API key from Lidarr settings" }}
        {...lidarr}
      />

      {/* Seerr */}
      <SeerrSection {...seerr} />
    </div>
  );
}

// ─── Shared Arr Section ───

interface ArrSectionRendererProps extends ArrSectionProps {
  title: string;
  idPrefix: string;
  placeholder: { name: string; url: string; apiKey: string };
}

function ArrSection({
  title,
  idPrefix,
  placeholder,
  instances,
  showForm,
  form,
  saving,
  error,
  testing,
  testResult,
  editing,
  onShowForm,
  onFormChange,
  onAdd,
  onDelete,
  onTest,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditFormChange,
  onEditTest,
  onToggleEnabled,
}: ArrSectionRendererProps) {
  const style = INTEGRATION_TYPE_STYLES[idPrefix] ?? INTEGRATION_TYPE_STYLES.sonarr;
  const disabledCount = instances.filter((i) => !i.enabled).length;
  const hasInstances = instances.length > 0;

  return (
    <section>
      <SectionHeader
        title={title}
        icon={Boxes}
        style={style}
        count={instances.length}
        disabledCount={disabledCount}
        showAddButton={hasInstances && !showForm}
        onShowForm={() => onShowForm(!showForm)}
      />

      {showForm && (
        <Card className={cn("mb-4 border-l-2", style.border)}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Plus className={cn("h-4 w-4", style.text)} />
              Add {title} Instance
            </CardTitle>
            <CardDescription>
              Connection will be tested before saving.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 *:space-y-1.5">
              <div>
                <Label htmlFor={`${idPrefix}-name`}>Name</Label>
                <Input
                  id={`${idPrefix}-name`}
                  placeholder={placeholder.name}
                  value={form.name}
                  onChange={(e) =>
                    onFormChange({ ...form, name: e.target.value })
                  }
                />
              </div>
              <div>
                <Label htmlFor={`${idPrefix}-url`}>URL</Label>
                <Input
                  id={`${idPrefix}-url`}
                  placeholder={placeholder.url}
                  value={form.url}
                  onChange={(e) =>
                    onFormChange({ ...form, url: e.target.value })
                  }
                />
              </div>
              <div>
                <Label htmlFor={`${idPrefix}-external-url`}>External URL</Label>
                <Input
                  id={`${idPrefix}-external-url`}
                  placeholder="Browser-accessible URL (optional)"
                  value={form.externalUrl}
                  onChange={(e) =>
                    onFormChange({ ...form, externalUrl: e.target.value })
                  }
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Used for &quot;Open in&quot; links. Falls back to URL above if empty.
                </p>
              </div>
              <div>
                <Label htmlFor={`${idPrefix}-key`}>API Key</Label>
                <SecretInput
                  id={`${idPrefix}-key`}
                  placeholder={placeholder.apiKey}
                  value={form.apiKey}
                  onChange={(e) =>
                    onFormChange({ ...form, apiKey: e.target.value })
                  }
                />
              </div>
            </div>
            {error && (
              <p className="mt-2 text-sm text-destructive">{error}</p>
            )}
            <div className="mt-4 flex items-center gap-2">
              <Button
                onClick={onAdd}
                disabled={
                  saving ||
                  !form.name ||
                  !form.url ||
                  !form.apiKey ||
                  !testResult?.ok
                }
              >
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save
              </Button>
              <Button
                variant="outline"
                onClick={onTest}
                disabled={testing || !form.url || !form.apiKey}
              >
                {testing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle className="mr-2 h-4 w-4" />
                )}
                Test
              </Button>
              <Button
                variant="ghost"
                onClick={() => onShowForm(false)}
              >
                Cancel
              </Button>
              {testResult && <TestResultBadge result={testResult} />}
            </div>
          </CardContent>
        </Card>
      )}

      {instances.length === 0 && !showForm ? (
        <EmptyState
          title={title}
          icon={Boxes}
          style={style}
          description={`Connect your ${title} server to enable lifecycle matching and tag sync.`}
          onAdd={() => onShowForm(true)}
        />
      ) : (
        <div className="space-y-2">
          {instances.map((instance) => (
            <Card key={instance.id} className="overflow-hidden transition-colors hover:bg-muted/20">
              <CardContent className="py-4">
                {editing.id === instance.id ? (
                  <div className="space-y-3">
                    <div className="grid gap-4 sm:grid-cols-2 *:space-y-1.5">
                      <div>
                        <Label>Name</Label>
                        <Input
                          value={editing.form.name}
                          onChange={(e) => onEditFormChange({ ...editing.form, name: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label>URL</Label>
                        <Input
                          value={editing.form.url}
                          onChange={(e) => onEditFormChange({ ...editing.form, url: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label>External URL</Label>
                        <Input
                          placeholder="Browser-accessible URL (optional)"
                          value={editing.form.externalUrl}
                          onChange={(e) => onEditFormChange({ ...editing.form, externalUrl: e.target.value })}
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                          Used for &quot;Open in&quot; links. Falls back to URL above if empty.
                        </p>
                      </div>
                      <div>
                        <Label>API Key</Label>
                        <SecretInput
                          placeholder="Leave blank to keep current"
                          value={editing.form.apiKey}
                          onChange={(e) => onEditFormChange({ ...editing.form, apiKey: e.target.value })}
                        />
                      </div>
                    </div>
                    {editing.error && (
                      <p className="text-sm text-destructive">{editing.error}</p>
                    )}
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={onSaveEdit}
                        disabled={editing.saving || !editing.form.name || !editing.form.url || !editing.testResult?.ok}
                      >
                        {editing.saving ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="mr-2 h-4 w-4" />
                        )}
                        Save
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={onEditTest}
                        disabled={editing.testing || !editing.form.url}
                      >
                        {editing.testing ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <CheckCircle className="mr-2 h-4 w-4" />
                        )}
                        Test
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={onCancelEdit}
                      >
                        Cancel
                      </Button>
                      {editing.testResult && <TestResultBadge result={editing.testResult} />}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span
                        className={cn(
                          "h-2 w-2 shrink-0 rounded-full",
                          style.dot,
                          !instance.enabled && "opacity-30 shadow-none",
                        )}
                        aria-hidden
                      />
                      <div className={cn("min-w-0 flex-1 space-y-0.5", !instance.enabled && "opacity-60")}>
                        <div className="flex items-center gap-2">
                          <p className="truncate font-medium">{instance.name}</p>
                          {!instance.enabled && (
                            <ColorChip className="border-amber-500/30 bg-amber-500/15 text-[10px] font-medium text-amber-400">
                              Disabled
                            </ColorChip>
                          )}
                        </div>
                        <p className="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                          <Link2 className="h-3 w-3 shrink-0" />
                          <span className="truncate font-mono text-xs">{instance.url}</span>
                        </p>
                        {instance.externalUrl && (
                          <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground/70">
                            <ExternalLink className="h-3 w-3 shrink-0" />
                            <span className="truncate font-mono">{instance.externalUrl}</span>
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Switch
                        checked={instance.enabled}
                        onCheckedChange={(checked) => onToggleEnabled(instance.id, checked)}
                      />
                      <Separator orientation="vertical" className="mx-1 h-6" />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onStartEdit(instance)}
                        title="Edit instance"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => onDelete(instance.id)}
                        title="Delete instance"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Seerr Section ───

function SeerrSection({
  instances,
  showForm,
  form,
  saving,
  error,
  testing,
  testResult,
  editing,
  onShowForm,
  onFormChange,
  onAdd,
  onDelete,
  onTest,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditFormChange,
  onEditTest,
  onToggleEnabled,
}: SeerrSectionProps) {
  const style = INTEGRATION_TYPE_STYLES.seerr;
  const disabledCount = instances.filter((i) => !i.enabled).length;
  const hasInstances = instances.length > 0;

  return (
    <section>
      <SectionHeader
        title="Seerr"
        icon={Inbox}
        style={style}
        count={instances.length}
        disabledCount={disabledCount}
        showAddButton={hasInstances && !showForm}
        onShowForm={() => onShowForm(!showForm)}
      />

      {showForm && (
        <Card className={cn("mb-4 border-l-2", style.border)}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Plus className={cn("h-4 w-4", style.text)} />
              Add Seerr Instance
            </CardTitle>
            <CardDescription>
              Manage request integration instances.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-4">
              <div>
                <Label htmlFor="seerr-name">Name</Label>
                <Input
                  id="seerr-name"
                  placeholder="My Seerr"
                  value={form.name}
                  onChange={(e) =>
                    onFormChange({ ...form, name: e.target.value })
                  }
                />
              </div>
              <div>
                <Label htmlFor="seerr-url">URL</Label>
                <Input
                  id="seerr-url"
                  placeholder="http://localhost:5055"
                  value={form.url}
                  onChange={(e) =>
                    onFormChange({ ...form, url: e.target.value })
                  }
                />
              </div>
              <div>
                <Label htmlFor="seerr-key">API Key</Label>
                <SecretInput
                  id="seerr-key"
                  placeholder="API key from Seerr settings"
                  value={form.apiKey}
                  onChange={(e) =>
                    onFormChange({ ...form, apiKey: e.target.value })
                  }
                />
              </div>
            </div>
            {error && (
              <p className="mt-2 text-sm text-destructive">{error}</p>
            )}
            <div className="mt-4 flex items-center gap-2">
              <Button
                onClick={onAdd}
                disabled={
                  saving ||
                  !form.name ||
                  !form.url ||
                  !form.apiKey ||
                  !testResult?.ok
                }
              >
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save
              </Button>
              <Button
                variant="outline"
                onClick={onTest}
                disabled={testing || !form.url || !form.apiKey}
              >
                {testing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle className="mr-2 h-4 w-4" />
                )}
                Test
              </Button>
              <Button
                variant="ghost"
                onClick={() => onShowForm(false)}
              >
                Cancel
              </Button>
              {testResult && <TestResultBadge result={testResult} />}
            </div>
          </CardContent>
        </Card>
      )}

      {instances.length === 0 && !showForm ? (
        <EmptyState
          title="Seerr"
          icon={Inbox}
          style={style}
          description="Connect Overseerr or Jellyseerr to surface request data alongside your library."
          onAdd={() => onShowForm(true)}
        />
      ) : (
        <div className="space-y-2">
          {instances.map((instance) => (
            <Card key={instance.id} className="overflow-hidden transition-colors hover:bg-muted/20">
              <CardContent className="py-4">
                {editing.id === instance.id ? (
                  <div className="space-y-3">
                    <div className="grid gap-4 sm:grid-cols-4">
                      <div>
                        <Label>Name</Label>
                        <Input
                          value={editing.form.name}
                          onChange={(e) => onEditFormChange({ ...editing.form, name: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label>URL</Label>
                        <Input
                          value={editing.form.url}
                          onChange={(e) => onEditFormChange({ ...editing.form, url: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label>API Key</Label>
                        <SecretInput
                          placeholder="Leave blank to keep current"
                          value={editing.form.apiKey}
                          onChange={(e) => onEditFormChange({ ...editing.form, apiKey: e.target.value })}
                        />
                      </div>
                    </div>
                    {editing.error && (
                      <p className="text-sm text-destructive">{editing.error}</p>
                    )}
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={onSaveEdit}
                        disabled={editing.saving || !editing.form.name || !editing.form.url || !editing.testResult?.ok}
                      >
                        {editing.saving ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="mr-2 h-4 w-4" />
                        )}
                        Save
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={onEditTest}
                        disabled={editing.testing || !editing.form.url}
                      >
                        {editing.testing ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <CheckCircle className="mr-2 h-4 w-4" />
                        )}
                        Test
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={onCancelEdit}
                      >
                        Cancel
                      </Button>
                      {editing.testResult && <TestResultBadge result={editing.testResult} />}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span
                        className={cn(
                          "h-2 w-2 shrink-0 rounded-full",
                          style.dot,
                          !instance.enabled && "opacity-30 shadow-none",
                        )}
                        aria-hidden
                      />
                      <div className={cn("min-w-0 flex-1 space-y-0.5", !instance.enabled && "opacity-60")}>
                        <div className="flex items-center gap-2">
                          <p className="truncate font-medium">{instance.name}</p>
                          {!instance.enabled && (
                            <ColorChip className="border-amber-500/30 bg-amber-500/15 text-[10px] font-medium text-amber-400">
                              Disabled
                            </ColorChip>
                          )}
                        </div>
                        <p className="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                          <Link2 className="h-3 w-3 shrink-0" />
                          <span className="truncate font-mono text-xs">{instance.url}</span>
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Switch
                        checked={instance.enabled}
                        onCheckedChange={(checked) => onToggleEnabled(instance.id, checked)}
                      />
                      <Separator orientation="vertical" className="mx-1 h-6" />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onStartEdit(instance)}
                        title="Edit instance"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => onDelete(instance.id)}
                        title="Delete instance"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
