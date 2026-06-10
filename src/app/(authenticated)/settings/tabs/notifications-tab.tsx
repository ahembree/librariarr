"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { Label } from "@/components/ui/label";
import {
  CheckCircle,
  Loader2,
  Save,
  Webhook,
  XCircle,
} from "lucide-react";
import { SettingsSection } from "../components";
import type { TestResult } from "../types";

export interface NotificationsTabProps {
  discordWebhookUrl: string;
  discordWebhookUsername: string;
  discordWebhookAvatarUrl: string;
  discordSaving: boolean;
  discordTesting: boolean;
  discordTestResult: TestResult | null;
  onDiscordWebhookUrlChange: (value: string) => void;
  onDiscordWebhookUsernameChange: (value: string) => void;
  onDiscordWebhookAvatarUrlChange: (value: string) => void;
  onSaveDiscordSettings: () => void;
  onTestDiscordWebhook: () => void;
}

export function NotificationsTab({
  discordWebhookUrl,
  discordWebhookUsername,
  discordWebhookAvatarUrl,
  discordSaving,
  discordTesting,
  discordTestResult,
  onDiscordWebhookUrlChange,
  onDiscordWebhookUsernameChange,
  onDiscordWebhookAvatarUrlChange,
  onSaveDiscordSettings,
  onTestDiscordWebhook,
}: NotificationsTabProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">Notifications</h2>
        <p className="text-sm text-muted-foreground">
          Configure how Librariarr notifies you about important events like lifecycle actions and maintenance changes.
        </p>
      </div>

      <SettingsSection
        icon={Webhook}
        title="Discord Webhook"
        description="Send notifications to a Discord channel via webhook. Copy the webhook URL from your Discord server's integration settings."
        contentClassName="space-y-6"
      >
          <div className="space-y-2">
            <Label htmlFor="discord-webhook-url">Webhook URL</Label>
            <SecretInput
              id="discord-webhook-url"
              placeholder="https://discord.com/api/webhooks/..."
              value={discordWebhookUrl}
              onChange={(e) => onDiscordWebhookUrlChange(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="discord-webhook-username">Custom Username (optional)</Label>
            <Input
              id="discord-webhook-username"
              placeholder="Librariarr"
              value={discordWebhookUsername}
              onChange={(e) => onDiscordWebhookUsernameChange(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="discord-webhook-avatar">Custom Avatar URL (optional)</Label>
            <Input
              id="discord-webhook-avatar"
              type="url"
              placeholder="https://example.com/avatar.png"
              value={discordWebhookAvatarUrl}
              onChange={(e) => onDiscordWebhookAvatarUrlChange(e.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={onSaveDiscordSettings} disabled={discordSaving}>
              {discordSaving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save
            </Button>
            <Button
              variant="outline"
              onClick={onTestDiscordWebhook}
              disabled={discordTesting || !discordWebhookUrl}
            >
              {discordTesting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Test Webhook
            </Button>
            {discordTestResult && (
              discordTestResult.ok ? (
                <span className="flex items-center gap-1 text-sm text-green-500">
                  <CheckCircle className="h-4 w-4" /> Success
                </span>
              ) : (
                <span className="flex items-center gap-1 text-sm text-destructive">
                  <XCircle className="h-4 w-4" /> {discordTestResult.error || "Failed"}
                </span>
              )
            )}
          </div>
      </SettingsSection>
    </div>
  );
}
