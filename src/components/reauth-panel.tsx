"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePlexOAuth } from "@/hooks/use-plex-oauth";
import {
  reauthWithOidcPopup,
  reauthWithPlexToken,
  reauthWithProxy,
  type ReauthMethod,
  type ReauthResult,
} from "@/lib/auth/reauth-client";

/**
 * The "Confirm it's you" buttons: one per way this account can renew its
 * sign-in in place. `onConfirmed` runs once the server has accepted one.
 */
export function ReauthPanel({
  methods,
  onConfirmed,
  disabled = false,
}: {
  methods: ReauthMethod[];
  onConfirmed: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<ReauthMethod | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plex = usePlexOAuth({
    onSuccess: async (authToken) => {
      const result = await reauthWithPlexToken(authToken);
      if (!result.ok) throw new Error(result.error);
      await onConfirmed();
    },
  });

  const run = async (method: ReauthMethod, attempt: () => Promise<ReauthResult>) => {
    setBusy(method);
    setError(null);
    const result = await attempt();
    setBusy(null);
    if (result.ok) await onConfirmed();
    else if (result.error) setError(result.error);
  };

  if (methods.length === 0) {
    return <p className="text-sm text-muted-foreground">Sign out and back in, then try again.</p>;
  }

  const inProgress = busy !== null || plex.isLoading || disabled;
  const shownError = error ?? plex.error;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {methods.includes("plex") && (
          <Button
            size="sm"
            onClick={() => {
              setError(null);
              void plex.startAuth();
            }}
            disabled={inProgress}
          >
            {plex.isLoading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Sign in with Plex
          </Button>
        )}
        {methods.includes("oidc") && (
          <Button size="sm" onClick={() => void run("oidc", reauthWithOidcPopup)} disabled={inProgress}>
            {busy === "oidc" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Sign in with SSO
          </Button>
        )}
        {methods.includes("forward") && (
          <Button size="sm" onClick={() => void run("forward", reauthWithProxy)} disabled={inProgress}>
            {busy === "forward" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Confirm with SSO
          </Button>
        )}
        {plex.isLoading && (
          <Button size="sm" variant="ghost" onClick={plex.cancel}>
            Cancel
          </Button>
        )}
      </div>
      {plex.isLoading && plex.authUrl && (
        <p className="text-xs text-muted-foreground">
          No sign-in window?{" "}
          <a href={plex.authUrl} target="_blank" rel="noopener noreferrer" className="underline">
            Open Plex sign-in
          </a>
        </p>
      )}
      {shownError && <p className="text-xs text-destructive">{shownError}</p>}
    </div>
  );
}
