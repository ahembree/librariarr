"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Loader2,
  Plus,
  CheckCircle,
  Trash2,
  Save,
  Pencil,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ArrInstance, SeerrInstance, TestResult } from "../types";

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
    <div className="space-y-8">
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
  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">{title}</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onShowForm(!showForm)}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Instance
        </Button>
      </div>

      {showForm && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Add {title} Instance</CardTitle>
            <CardDescription>
              Connection will be tested before saving.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
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
              <p className="mt-2 text-sm text-red-400">{error}</p>
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
              {testResult && (
                <span className={`text-sm ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
                  {testResult.ok ? `Connected${testResult.appName ? ` to ${testResult.appName}` : ""}${testResult.version ? ` v${testResult.version}` : ""}` : `Failed: ${testResult.error}`}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {instances.length === 0 && !showForm ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">
              No {title} instances configured.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {instances.map((instance) => (
            <Card key={instance.id}>
              <CardContent className="py-4">
                {editing.id === instance.id ? (
                  <div className="space-y-3">
                    <div className="grid gap-4 sm:grid-cols-2">
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
                      <p className="text-sm text-red-400">{editing.error}</p>
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
                      {editing.testResult && (
                        <span className={`text-sm ${editing.testResult.ok ? "text-green-400" : "text-red-400"}`}>
                          {editing.testResult.ok ? `Connected${editing.testResult.appName ? ` to ${editing.testResult.appName}` : ""}${editing.testResult.version ? ` v${editing.testResult.version}` : ""}` : `Failed: ${editing.testResult.error}`}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className={cn("flex-1", !instance.enabled && "opacity-50")}>
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{instance.name}</p>
                        {!instance.enabled && (
                          <Badge variant="secondary" className="text-xs font-normal bg-amber-500/20 text-amber-400">
                            Disabled
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {instance.url}
                      </p>
                      {instance.externalUrl && (
                        <p className="text-xs text-muted-foreground/70">
                          External: {instance.externalUrl}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Switch
                        checked={instance.enabled}
                        onCheckedChange={(checked) => onToggleEnabled(instance.id, checked)}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onStartEdit(instance)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-400 hover:text-red-300"
                        onClick={() => onDelete(instance.id)}
                      >
                        <Trash2 className="h-4 w-4" />
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
  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Seerr</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onShowForm(!showForm)}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Instance
        </Button>
      </div>

      {showForm && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Add Seerr Instance</CardTitle>
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
              <p className="mt-2 text-sm text-red-400">{error}</p>
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
              {testResult && (
                <span className={`text-sm ${testResult.ok ? "text-green-400" : "text-red-400"}`}>
                  {testResult.ok ? `Connected${testResult.appName ? ` to ${testResult.appName}` : ""}${testResult.version ? ` v${testResult.version}` : ""}` : `Failed: ${testResult.error}`}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {instances.length === 0 && !showForm ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">
              No Seerr instances configured.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {instances.map((instance) => (
            <Card key={instance.id}>
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
                      <p className="text-sm text-red-400">{editing.error}</p>
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
                      {editing.testResult && (
                        <span className={`text-sm ${editing.testResult.ok ? "text-green-400" : "text-red-400"}`}>
                          {editing.testResult.ok ? `Connected${editing.testResult.appName ? ` to ${editing.testResult.appName}` : ""}${editing.testResult.version ? ` v${editing.testResult.version}` : ""}` : `Failed: ${editing.testResult.error}`}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className={cn("flex items-center gap-2 flex-1", !instance.enabled && "opacity-50")}>
                      <p className="font-medium">{instance.name}</p>
                      {!instance.enabled && (
                        <Badge variant="secondary" className="text-xs font-normal bg-amber-500/20 text-amber-400">
                          Disabled
                        </Badge>
                      )}
                      <p className="text-sm text-muted-foreground">
                        {instance.url}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Switch
                        checked={instance.enabled}
                        onCheckedChange={(checked) => onToggleEnabled(instance.id, checked)}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onStartEdit(instance)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-400 hover:text-red-300"
                        onClick={() => onDelete(instance.id)}
                      >
                        <Trash2 className="h-4 w-4" />
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
