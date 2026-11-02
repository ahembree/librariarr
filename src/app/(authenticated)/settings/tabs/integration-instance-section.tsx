"use client";

import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ColorChip } from "@/components/color-chip";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ConnectionTestResult } from "@/components/connection-test-result";
import { LoadingButton } from "@/components/loading-button";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Plus, CheckCircle, Trash2, Save, Pencil, Link2, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { changesConnection, type IntegrationBehavior, type IntegrationInstance } from "../integration-instances";
import type { IntegrationInstancesState } from "../use-integration-instances";

/** Colours matching the dots on the media-detail Arr cards. */
export interface IntegrationTypeStyle {
  text: string;
  dot: string;
  tile: string;
  border: string;
}

/** Everything one type's section shows: its behaviour plus its copy. */
export interface IntegrationSectionConfig extends IntegrationBehavior {
  icon: LucideIcon;
  style: IntegrationTypeStyle;
  placeholder: { name: string; url: string; apiKey: string };
  /** Under the add form's title. */
  addDescription: string;
  /** Under "No <label> instances yet". */
  emptyDescription: string;
  /** Under the External URL field (types with one). */
  externalUrlHint?: string;
  /** The form grid's columns. */
  gridClassName: string;
  /** A paragraph under the section header. */
  intro?: ReactNode;
  /** The removal dialog's consequence, replacing the lifecycle-matching default. */
  removeConsequence?: ReactNode;
}

function InstancesSectionHeader({
  config,
  count,
  disabledCount,
  showAddButton,
  onAdd,
}: {
  config: IntegrationSectionConfig;
  count: number;
  disabledCount: number;
  showAddButton: boolean;
  onAdd: () => void;
}) {
  const { icon: Icon, style } = config;
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border", style.tile, style.border)}>
          <Icon className={cn("h-4 w-4", style.text)} />
        </div>
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold leading-tight">{config.label}</h3>
          {count > 0 && (
            <p className="text-xs text-muted-foreground">
              {count} {count === 1 ? "instance" : "instances"}
              {disabledCount > 0 && ` · ${disabledCount} disabled`}
            </p>
          )}
        </div>
      </div>
      {showAddButton && (
        <Button variant="outline" size="sm" onClick={onAdd} className="shrink-0">
          <Plus className="mr-2 h-4 w-4" />
          Add Instance
        </Button>
      )}
    </div>
  );
}

function InstancesEmptyState({ config, onAdd }: { config: IntegrationSectionConfig; onAdd: () => void }) {
  const { icon: Icon, style } = config;
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center gap-4 py-10 text-center">
        <div className={cn("flex h-12 w-12 items-center justify-center rounded-xl border", style.tile, style.border)}>
          <Icon className={cn("h-6 w-6", style.text)} />
        </div>
        <div className="space-y-1">
          <p className="font-medium">No {config.label} instances yet</p>
          <p className="text-xs text-muted-foreground">{config.emptyDescription}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onAdd}>
          <Plus className="mr-2 h-4 w-4" />
          Add {config.label} Instance
        </Button>
      </CardContent>
    </Card>
  );
}

/** One instance row: name, URLs, the enable toggle, Edit and Remove. */
function InstanceRow<I extends IntegrationInstance>({
  instance,
  style,
  onToggle,
  onEdit,
  onRemove,
}: {
  instance: I;
  style: IntegrationTypeStyle;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          className={cn("h-2 w-2 shrink-0 rounded-full", style.dot, !instance.enabled && "opacity-30 shadow-none")}
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
        <Switch checked={instance.enabled} onCheckedChange={onToggle} />
        <Separator orientation="vertical" className="mx-1 h-6" />
        <Button variant="ghost" size="icon-sm" onClick={onEdit} title="Edit instance">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onRemove}
          aria-label={`Remove ${instance.name}`}
          title="Remove instance"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * One integration type on Settings → Integrations: the add form, the list of
 * instances with their inline edit form, and the removal confirmation. Every
 * type renders through this; `config` says what differs (copy, columns,
 * whether there is an External URL, whether the add form tests first) and
 * `state` comes from `useIntegrationInstances`.
 */
export function IntegrationInstanceSection<I extends IntegrationInstance>({
  config,
  state,
}: {
  config: IntegrationSectionConfig;
  state: IntegrationInstancesState<I>;
}) {
  const { type, label, style, placeholder, hasExternalUrl, testBeforeAdd } = config;
  const { instances, add, edit } = state;
  const disabledCount = instances.filter((i) => !i.enabled).length;
  // Kept after the dialog closes, so its title doesn't empty while it fades.
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const gridClassName = cn("grid gap-4 *:space-y-1.5", config.gridClassName);

  return (
    <section>
      <InstancesSectionHeader
        config={config}
        count={instances.length}
        disabledCount={disabledCount}
        showAddButton={instances.length > 0 && !add.open}
        onAdd={() => add.setOpen(!add.open)}
      />

      {config.intro && <p className="-mt-2 mb-4 text-xs text-muted-foreground">{config.intro}</p>}

      {add.open && (
        <Card className={cn("mb-4 border-l-2", style.border)}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Plus className={cn("h-4 w-4", style.text)} />
              Add {label} Instance
            </CardTitle>
            <CardDescription>{config.addDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className={gridClassName}>
              <div>
                <Label htmlFor={`${type}-name`}>Name</Label>
                <Input
                  id={`${type}-name`}
                  placeholder={placeholder.name}
                  value={add.form.name}
                  onChange={(e) => add.setForm({ ...add.form, name: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor={`${type}-url`}>URL</Label>
                <Input
                  id={`${type}-url`}
                  placeholder={placeholder.url}
                  value={add.form.url}
                  onChange={(e) => add.setForm({ ...add.form, url: e.target.value })}
                />
              </div>
              {hasExternalUrl && (
                <div>
                  <Label htmlFor={`${type}-external-url`}>External URL</Label>
                  <Input
                    id={`${type}-external-url`}
                    placeholder="Browser-accessible URL (optional)"
                    value={add.form.externalUrl}
                    onChange={(e) => add.setForm({ ...add.form, externalUrl: e.target.value })}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">{config.externalUrlHint}</p>
                </div>
              )}
              <div>
                <Label htmlFor={`${type}-key`}>API Key</Label>
                <SecretInput
                  id={`${type}-key`}
                  placeholder={placeholder.apiKey}
                  value={add.form.apiKey}
                  onChange={(e) => add.setForm({ ...add.form, apiKey: e.target.value })}
                />
              </div>
            </div>
            {add.error && <p className="mt-2 text-sm text-destructive">{add.error}</p>}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <LoadingButton
                icon={Save}
                loading={add.saving}
                onClick={() => void add.submit()}
                disabled={!add.form.name || !add.form.url || !add.form.apiKey || (testBeforeAdd && !add.testResult?.ok)}
              >
                Save
              </LoadingButton>
              {testBeforeAdd && (
                <LoadingButton
                  variant="outline"
                  icon={CheckCircle}
                  loading={add.testing}
                  onClick={() => void add.test()}
                  disabled={!add.form.url || !add.form.apiKey}
                >
                  Test
                </LoadingButton>
              )}
              <Button variant="ghost" onClick={() => add.setOpen(false)}>
                Cancel
              </Button>
              {add.testResult && <ConnectionTestResult variant="badge" result={add.testResult} />}
            </div>
          </CardContent>
        </Card>
      )}

      {instances.length === 0 && !add.open ? (
        <InstancesEmptyState config={config} onAdd={() => add.setOpen(true)} />
      ) : (
        <div className="space-y-2">
          {instances.map((instance) => (
            <Card key={instance.id} className="overflow-hidden transition-colors hover:bg-muted/20">
              <CardContent className="py-4">
                {edit.id === instance.id ? (
                  <div className="space-y-3">
                    <div className={gridClassName}>
                      <div>
                        <Label htmlFor={`${type}-edit-name`}>Name</Label>
                        <Input
                          id={`${type}-edit-name`}
                          value={edit.form.name}
                          onChange={(e) => edit.setForm({ ...edit.form, name: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label htmlFor={`${type}-edit-url`}>URL</Label>
                        <Input
                          id={`${type}-edit-url`}
                          value={edit.form.url}
                          onChange={(e) => edit.setForm({ ...edit.form, url: e.target.value })}
                        />
                      </div>
                      {hasExternalUrl && (
                        <div>
                          <Label htmlFor={`${type}-edit-external-url`}>External URL</Label>
                          <Input
                            id={`${type}-edit-external-url`}
                            placeholder="Browser-accessible URL (optional)"
                            value={edit.form.externalUrl}
                            onChange={(e) => edit.setForm({ ...edit.form, externalUrl: e.target.value })}
                          />
                          <p className="mt-1 text-xs text-muted-foreground">{config.externalUrlHint}</p>
                        </div>
                      )}
                      <div>
                        <Label htmlFor={`${type}-edit-key`}>API Key</Label>
                        <SecretInput
                          id={`${type}-edit-key`}
                          placeholder="Leave blank to keep current"
                          value={edit.form.apiKey}
                          onChange={(e) => edit.setForm({ ...edit.form, apiKey: e.target.value })}
                        />
                      </div>
                    </div>
                    {edit.error && <p className="text-sm text-destructive">{edit.error}</p>}
                    <div className="flex flex-wrap items-center gap-2">
                      <LoadingButton
                        size="sm"
                        icon={Save}
                        loading={edit.saving}
                        onClick={() => void edit.save()}
                        disabled={
                          !edit.form.name ||
                          !edit.form.url ||
                          (changesConnection(edit.form, instance) && !edit.testResult?.ok)
                        }
                      >
                        Save
                      </LoadingButton>
                      <LoadingButton
                        variant="outline"
                        size="sm"
                        icon={CheckCircle}
                        loading={edit.testing}
                        onClick={() => void edit.test()}
                        disabled={!edit.form.url}
                      >
                        Test
                      </LoadingButton>
                      <Button variant="ghost" size="sm" onClick={edit.cancel}>
                        Cancel
                      </Button>
                      {edit.testResult && <ConnectionTestResult variant="badge" result={edit.testResult} />}
                    </div>
                  </div>
                ) : (
                  <InstanceRow
                    instance={instance}
                    style={style}
                    onToggle={(checked) => void state.setEnabled(instance.id, checked)}
                    onEdit={() => edit.start(instance)}
                    onRemove={() => {
                      setRemoveTarget({ id: instance.id, name: instance.name });
                      setRemoveOpen(true);
                    }}
                  />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={`Remove ${removeTarget?.name ?? ""}?`}
        description={
          config.removeConsequence ?? (
            <>
              This removes the {label} connection from Librariarr — lifecycle rules will no longer match or act on
              items through it. Nothing is changed in {label} itself.
            </>
          )
        }
        confirmLabel="Remove"
        confirmIcon={Trash2}
        destructive
        onConfirm={() => {
          if (removeTarget) void state.remove(removeTarget.id);
        }}
      />
    </section>
  );
}
