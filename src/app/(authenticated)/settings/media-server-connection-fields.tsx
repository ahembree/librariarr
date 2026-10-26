"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import { Switch } from "@/components/ui/switch";

/** What a Jellyfin or Emby server form holds. */
export interface MediaServerConnectionValue {
  name: string;
  url: string;
  apiKey: string;
  tlsSkipVerify: boolean;
}

/**
 * The fields of a Jellyfin/Emby server form — URL, API key, the TLS switch,
 * and on onboarding a name — shared by Settings → Media Servers → Add Server
 * and onboarding, which had each written them out (onboarding's API key in a
 * plain text box). Field ids are `<idPrefix>-name|url|apikey|tls`.
 *
 * Every edit goes through `onChange` with the whole value, so the caller can
 * drop a connection test that no longer describes what is on screen.
 */
export function MediaServerConnectionFields({
  idPrefix,
  value,
  onChange,
  namePlaceholder,
  urlPlaceholder = "http://your-server:8096",
}: {
  idPrefix: string;
  value: MediaServerConnectionValue;
  onChange: (value: MediaServerConnectionValue) => void;
  /** Shows the optional name field (onboarding; Settings names the server from its test). */
  namePlaceholder?: string;
  urlPlaceholder?: string;
}) {
  return (
    <>
      {namePlaceholder !== undefined && (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-name`}>Server Name (optional)</Label>
          <Input
            id={`${idPrefix}-name`}
            placeholder={namePlaceholder}
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-url`}>URL</Label>
        <Input
          id={`${idPrefix}-url`}
          placeholder={urlPlaceholder}
          value={value.url}
          onChange={(e) => onChange({ ...value, url: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">Must include http:// or https://</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-apikey`}>API Key</Label>
        <SecretInput
          id={`${idPrefix}-apikey`}
          placeholder="API key from dashboard"
          value={value.apiKey}
          onChange={(e) => onChange({ ...value, apiKey: e.target.value })}
        />
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={`${idPrefix}-tls`}
          checked={value.tlsSkipVerify}
          onCheckedChange={(checked) => onChange({ ...value, tlsSkipVerify: checked })}
        />
        <Label htmlFor={`${idPrefix}-tls`} className="text-sm">
          Skip TLS verification
        </Label>
      </div>
    </>
  );
}
