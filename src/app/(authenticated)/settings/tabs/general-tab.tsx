"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Loader2,
  CheckCircle,
  Trash2,
  Download,
  DatabaseBackup,
  RotateCcw,
  Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ACCENT_PRESETS } from "@/lib/theme/accent-colors";
import {
  COLOR_PALETTE,
  CHIP_CATEGORY_LABELS,
  CHIP_CATEGORY_ORDER,
  getChipBadgeStyle,
} from "@/lib/theme/chip-colors";
import type { ChipColorMap, ChipColorCategory, MediaServer, BackupEntry } from "../types";
import { getServerDisplayNames } from "@/lib/server-styles";

export interface GeneralTabProps {
  // Accent color
  accentColor: string;
  onSaveAccentColor: (name: string) => void;

  // Chip colors
  chipColors: ChipColorMap;
  onSaveChipColor: (category: ChipColorCategory, key: string, hex: string) => void;
  onResetChipColors: () => void;

  // Dedup stats
  dedupStats: boolean;
  savingDedup: boolean;
  onSaveDedupSetting: (checked: boolean) => void;

  // Log retention
  logRetentionDays: number;
  logRetentionInput: string;
  savingLogRetention: boolean;
  onLogRetentionInputChange: (value: string) => void;
  onSaveLogRetention: () => void;

  // Action history retention
  actionRetentionDays: number;
  actionRetentionInput: string;
  savingActionRetention: boolean;
  onActionRetentionInputChange: (value: string) => void;
  onSaveActionRetention: () => void;

  // Backup & Restore
  backupSchedule: string;
  backupRetentionCount: number;
  backups: BackupEntry[];
  backupLoading: boolean;
  backupSaving: boolean;
  creatingBackup: boolean;
  restoringBackup: string | null;
  restoreProgress: string | null;
  hasBackupPassword: boolean;
  savingBackupPassword: boolean;
  onBackupScheduleChange: (value: string) => void;
  onBackupRetentionCountChange: (value: number) => void;
  onSaveBackupRetention: () => void;
  onSaveBackupPassword: (password: string | null) => void;
  onCreateBackup: (includeMediaData?: boolean) => void;
  onDownloadBackup: (filename: string) => void;
  onRestoreBackup: (filename: string, passphrase?: string) => void;
  onDeleteBackup: (filename: string) => void;

  // Library Display (multi-server)
  servers: MediaServer[];
  preferredTitleServerId: string | null;
  preferredArtworkServerId: string | null;
  onSavePreferredTitleServer: (value: string) => void;
  onSavePreferredArtworkServer: (value: string) => void;
}

export function GeneralTab({
  accentColor,
  onSaveAccentColor,
  chipColors,
  onSaveChipColor,
  onResetChipColors,
  dedupStats,
  savingDedup,
  onSaveDedupSetting,
  logRetentionDays,
  logRetentionInput,
  savingLogRetention,
  onLogRetentionInputChange,
  onSaveLogRetention,
  actionRetentionDays,
  actionRetentionInput,
  savingActionRetention,
  onActionRetentionInputChange,
  onSaveActionRetention,
  backupSchedule,
  backupRetentionCount,
  backups,
  backupLoading,
  backupSaving,
  creatingBackup,
  restoringBackup,
  restoreProgress,
  hasBackupPassword,
  savingBackupPassword,
  onBackupScheduleChange,
  onBackupRetentionCountChange,
  onSaveBackupRetention,
  onSaveBackupPassword,
  onCreateBackup,
  onDownloadBackup,
  onRestoreBackup,
  onDeleteBackup,
  servers,
  preferredTitleServerId,
  preferredArtworkServerId,
  onSavePreferredTitleServer,
  onSavePreferredArtworkServer,
}: GeneralTabProps) {
  const [encryptionPasswordInput, setEncryptionPasswordInput] = useState("");
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [restorePassphraseFor, setRestorePassphraseFor] = useState<string | null>(null);
  const [restorePassphraseInput, setRestorePassphraseInput] = useState("");
  const [includeMediaData, setIncludeMediaData] = useState(false);

  return (
    <div className="space-y-8">
      {/* Appearance */}
      <section>
        <h2 className="text-xl font-semibold mb-4">Appearance</h2>
        <Card>
          <CardContent>
            <div>
              <Label>Accent Color</Label>
              <p className="text-sm text-muted-foreground mb-3">
                Choose a color theme for buttons, active items, and highlights.
              </p>
              <div className="flex flex-wrap gap-3">
                {ACCENT_PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    onClick={() => onSaveAccentColor(preset.name)}
                    className={`relative h-8 w-8 rounded-full border-2 transition-all ${
                      accentColor === preset.name
                        ? "border-foreground scale-110"
                        : "border-transparent hover:scale-105"
                    }`}
                    style={{ backgroundColor: preset.color }}
                    title={preset.label}
                  >
                    {accentColor === preset.name && (
                      <CheckCircle className="absolute inset-0 m-auto h-4 w-4 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]" />
                    )}
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Chip Colors */}
        <Card className="mt-4">
          <CardContent>
            <div className="flex items-center justify-between mb-3">
              <div>
                <Label>Badge & Chart Colors</Label>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Customize colors for resolution, dynamic range, and audio profile badges and charts.
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={onResetChipColors}
              >
                Reset to defaults
              </Button>
            </div>

            <div className="space-y-5">
              {CHIP_CATEGORY_ORDER.map((category) => (
                <div key={category}>
                  <p className="text-sm font-medium mb-2">{CHIP_CATEGORY_LABELS[category]}</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(chipColors[category]).map(([value, hex]) => (
                      <Popover key={value}>
                        <PopoverTrigger asChild>
                          <button
                            className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors hover:bg-muted cursor-pointer"
                            style={getChipBadgeStyle(hex)}
                          >
                            <span
                              className="h-3 w-3 rounded-full shrink-0 border border-white/20"
                              style={{ backgroundColor: hex }}
                            />
                            {value}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-auto p-3" sideOffset={4}>
                          <p className="text-xs font-medium mb-2">{value}</p>
                          <div className="grid grid-cols-6 gap-1.5">
                            {COLOR_PALETTE.map((preset) => (
                              <button
                                key={preset.hex}
                                className={cn(
                                  "h-7 w-7 rounded-full border-2 transition-all hover:scale-110",
                                  hex === preset.hex
                                    ? "border-foreground scale-110"
                                    : "border-transparent"
                                )}
                                style={{ backgroundColor: preset.hex }}
                                title={preset.name}
                                onClick={() => onSaveChipColor(category, value, preset.hex)}
                              />
                            ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Display */}
      <section>
        <h2 className="text-xl font-semibold mb-4">Display</h2>
        <Card>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Deduplicate stats across servers</Label>
                <p className="text-sm text-muted-foreground">
                  When enabled, items that exist on multiple media servers are counted once in dashboard statistics
                </p>
              </div>
              <Switch
                checked={dedupStats}
                onCheckedChange={(checked) => onSaveDedupSetting(checked)}
                disabled={savingDedup}
              />
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Log Retention */}
      <section>
        <h2 className="text-xl font-semibold mb-4">Log Retention</h2>
        <Card>
          <CardContent>
            <div className="flex items-center gap-4">
              <div>
                <Label htmlFor="log-retention">Keep logs for</Label>
                <div className="mt-1.5 flex items-center gap-2">
                  <Input
                    id="log-retention"
                    type="number"
                    min={1}
                    max={365}
                    value={logRetentionInput}
                    onChange={(e) => onLogRetentionInputChange(e.target.value)}
                    className="w-20"
                  />
                  <span className="text-sm text-muted-foreground">days</span>
                  <Button
                    size="sm"
                    onClick={onSaveLogRetention}
                    disabled={
                      savingLogRetention ||
                      logRetentionInput === String(logRetentionDays)
                    }
                  >
                    {savingLogRetention && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Previous days&apos; logs are archived to compressed tarballs in the config folder. Archives older than this are pruned.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Action History Retention */}
      <section>
        <h2 className="text-xl font-semibold mb-4">Action History Retention</h2>
        <Card>
          <CardContent>
            <div className="flex items-center gap-4">
              <div>
                <Label htmlFor="action-retention">Keep action history for</Label>
                <div className="mt-1.5 flex items-center gap-2">
                  <Input
                    id="action-retention"
                    type="number"
                    min={0}
                    max={365}
                    value={actionRetentionInput}
                    onChange={(e) => onActionRetentionInputChange(e.target.value)}
                    className="w-20"
                  />
                  <span className="text-sm text-muted-foreground">days</span>
                  <Button
                    size="sm"
                    onClick={onSaveActionRetention}
                    disabled={
                      savingActionRetention ||
                      actionRetentionInput === String(actionRetentionDays)
                    }
                  >
                    {savingActionRetention && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Completed and failed actions older than this will be automatically deleted. Set to 0 to keep forever.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Backup & Restore */}
      <section>
        <h2 className="text-xl font-semibold mb-4">Backup & Restore</h2>
        <Card>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="backup-schedule">Backup Schedule</Label>
                <Select
                  value={backupSchedule}
                  onValueChange={onBackupScheduleChange}
                >
                  <SelectTrigger id="backup-schedule" className="mt-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MANUAL">Manual only</SelectItem>
                    <SelectItem value="EVERY_6H">Every 6 hours</SelectItem>
                    <SelectItem value="EVERY_12H">Every 12 hours</SelectItem>
                    <SelectItem value="DAILY">Daily</SelectItem>
                    <SelectItem value="WEEKLY">Weekly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="backup-retention">Keep backups</Label>
                <div className="mt-1.5 flex items-center gap-2">
                  <Input
                    id="backup-retention"
                    type="number"
                    min={1}
                    max={100}
                    value={backupRetentionCount}
                    onChange={(e) => onBackupRetentionCountChange(Number(e.target.value) || 7)}
                    className="w-20"
                  />
                  <span className="text-sm text-muted-foreground">most recent</span>
                  <Button
                    size="sm"
                    disabled={backupSaving}
                    onClick={onSaveBackupRetention}
                  >
                    Save
                  </Button>
                </div>
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <Label>Encryption Password</Label>
                {hasBackupPassword && !showPasswordForm ? (
                  <div className="mt-1.5 flex items-center gap-3">
                    <div className="flex items-center gap-1.5 text-sm text-emerald-400">
                      <Lock className="h-3.5 w-3.5" />
                      Password is set — all backups are encrypted
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setShowPasswordForm(true)}>Change</Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={savingBackupPassword}
                      onClick={() => onSaveBackupPassword(null)}
                    >
                      Remove
                    </Button>
                  </div>
                ) : !hasBackupPassword && !showPasswordForm ? (
                  <div className="mt-1.5">
                    <p className="text-sm text-muted-foreground mb-2">No encryption password set — backups are unencrypted.</p>
                    <Button variant="outline" size="sm" onClick={() => setShowPasswordForm(true)}>Set Password</Button>
                  </div>
                ) : (
                  <div className="mt-1.5 flex items-center gap-2">
                    <Input
                      type="password"
                      placeholder="Min 8 characters"
                      value={encryptionPasswordInput}
                      onChange={(e) => setEncryptionPasswordInput(e.target.value)}
                      className="max-w-xs h-9 text-sm"
                    />
                    <Button
                      size="sm"
                      disabled={savingBackupPassword || encryptionPasswordInput.length < 8}
                      onClick={() => {
                        onSaveBackupPassword(encryptionPasswordInput);
                        setEncryptionPasswordInput("");
                        setShowPasswordForm(false);
                      }}
                    >
                      {savingBackupPassword ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Save
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setShowPasswordForm(false); setEncryptionPasswordInput(""); }}>
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  disabled={creatingBackup}
                  onClick={() => onCreateBackup(includeMediaData)}
                >
                  {creatingBackup ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <DatabaseBackup className="mr-2 h-4 w-4" />}
                  Create Backup
                </Button>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeMediaData}
                    onChange={(e) => setIncludeMediaData(e.target.checked)}
                    className="rounded border-input"
                  />
                  Include media data
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                By default, backups only include settings and configuration. Media data, streams, and logs are retrieved during a full sync.
              </p>
            </div>
            {backups.length > 0 && (
              <div className="space-y-2">
                <Label>Available Backups</Label>
                <div className="space-y-1.5 max-h-64 overflow-y-auto">
                  {backups.map((b) => (
                    <div key={b.filename} className="space-y-1.5 rounded-md border p-2.5 text-sm">
                      <div className="flex items-center justify-between">
                        <div className="min-w-0">
                          <p className="font-medium truncate flex items-center gap-1.5">
                            {b.filename}
                            {b.encrypted && <Lock className="h-3 w-3 text-muted-foreground" />}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(b.createdAt).toLocaleString()} — {b.size < 1024 * 1024 ? `${(b.size / 1024).toFixed(1)} KB` : `${(b.size / 1024 / 1024).toFixed(1)} MB`}
                            {b.tables && Object.keys(b.tables).length > 0
                              ? ` — ${Object.values(b.tables).reduce((a, c) => a + c, 0).toLocaleString()} rows`
                              : " — rows unknown"}
                            {b.encrypted && " — encrypted"}
                            {b.configOnly !== undefined ? (b.configOnly !== false ? " — config only" : " — full") : ""}
                          </p>
                        </div>
                        <div className="flex gap-1 shrink-0 ml-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => onDownloadBackup(b.filename)}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            disabled={restoringBackup === b.filename}
                            onClick={() => {
                              if (b.encrypted) {
                                setRestorePassphraseFor(b.filename);
                                setRestorePassphraseInput("");
                              } else {
                                onRestoreBackup(b.filename);
                              }
                            }}
                          >
                            {restoringBackup === b.filename ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => onDeleteBackup(b.filename)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      {restoringBackup === b.filename && restoreProgress && (
                        <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                          {restoreProgress}
                        </div>
                      )}
                      {restorePassphraseFor === b.filename && !restoringBackup && (
                        <div className="flex items-center gap-2 pt-1">
                          <Input
                            type="password"
                            placeholder="Enter passphrase"
                            value={restorePassphraseInput}
                            onChange={(e) => setRestorePassphraseInput(e.target.value)}
                            className="max-w-xs h-8 text-sm"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && restorePassphraseInput) {
                                onRestoreBackup(b.filename, restorePassphraseInput);
                                setRestorePassphraseFor(null);
                                setRestorePassphraseInput("");
                              } else if (e.key === "Escape") {
                                setRestorePassphraseFor(null);
                                setRestorePassphraseInput("");
                              }
                            }}
                          />
                          <Button
                            size="sm"
                            className="h-8"
                            disabled={!restorePassphraseInput}
                            onClick={() => {
                              onRestoreBackup(b.filename, restorePassphraseInput);
                              setRestorePassphraseFor(null);
                              setRestorePassphraseInput("");
                            }}
                          >
                            Restore
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8"
                            onClick={() => { setRestorePassphraseFor(null); setRestorePassphraseInput(""); }}
                          >
                            Cancel
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {backupLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading backups...
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {servers.length > 1 && (() => {
        const displayNames = getServerDisplayNames(servers);
        return (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Library Display</h2>
            <Card>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="title-preference">Preferred Title Source</Label>
                  <p className="text-sm text-muted-foreground mb-2">
                    When the same media exists on multiple servers, use titles from this server.
                  </p>
                  <Select
                    value={preferredTitleServerId ?? "none"}
                    onValueChange={onSavePreferredTitleServer}
                  >
                    <SelectTrigger id="title-preference" className="w-full sm:w-60">
                      <SelectValue placeholder="No preference" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No preference</SelectItem>
                      {servers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {displayNames.get(s.id) ?? s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="artwork-preference">Preferred Artwork Source</Label>
                  <p className="text-sm text-muted-foreground mb-2">
                    When the same media exists on multiple servers, use artwork from this server.
                  </p>
                  <Select
                    value={preferredArtworkServerId ?? "none"}
                    onValueChange={onSavePreferredArtworkServer}
                  >
                    <SelectTrigger id="artwork-preference" className="w-full sm:w-60">
                      <SelectValue placeholder="No preference" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No preference</SelectItem>
                      {servers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {displayNames.get(s.id) ?? s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          </div>
        );
      })()}
    </div>
  );
}
