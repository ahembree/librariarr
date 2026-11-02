"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/loading-button";
import { usePlexOAuth } from "@/hooks/use-plex-oauth";
import {
  reauthWithOidcPopup,
  reauthWithPassword,
  reauthWithPlexToken,
  reauthWithProxy,
  type ReauthMethod,
  type ReauthResult,
} from "@/lib/auth/reauth-client";

/** The confirm buttons' spinner: small buttons, so a tighter gap than the default. */
const SPINNER = "mr-1.5 h-4 w-4";

/**
 * The "Confirm it's you" controls: one per way this account can renew its
 * sign-in in place. `onConfirmed` runs once the server has accepted one —
 * and never after the panel has gone away (a dialog closed mid-sign-in), so a
 * confirmation that lands late cannot act on a form nobody is looking at.
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
  const [password, setPassword] = useState("");
  const mounted = useRef(false);
  const attempt = useRef<AbortController | null>(null);
  // The latest callback, not the one from the render the button was clicked
  // in: a sign-in can take minutes, and the caller's state (a form the user
  // kept editing, whether its dialog is still open) moves on meanwhile.
  const confirmed = useRef(onConfirmed);
  useEffect(() => {
    confirmed.current = onConfirmed;
  });
  const confirm = async () => {
    if (mounted.current) await confirmed.current();
  };

  const plex = usePlexOAuth({
    onSuccess: async (authToken) => {
      const result = await reauthWithPlexToken(authToken);
      if (!result.ok) throw new Error(result.error);
      await confirm();
    },
  });
  const cancelPlex = plex.cancel;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Gone mid-sign-in: stop waiting and close the sign-in window.
      attempt.current?.abort();
      cancelPlex();
    };
  }, [cancelPlex]);

  const run = async (method: ReauthMethod, prove: (signal: AbortSignal) => Promise<ReauthResult>) => {
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(method);
    setError(null);
    const result = await prove(controller.signal);
    if (!mounted.current) return;
    if (attempt.current === controller) attempt.current = null;
    setBusy(null);
    if (result.ok) await confirm();
    else if (result.error) setError(result.error);
    return result;
  };

  const submitPassword = async () => {
    if (!password) return;
    const result = await run("password", (signal) => reauthWithPassword(password, signal));
    if (result && !result.ok) setPassword("");
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
          <LoadingButton
            size="sm"
            onClick={() => {
              setError(null);
              void plex.startAuth();
            }}
            disabled={inProgress}
            loading={plex.isLoading}
            iconClassName={SPINNER}
          >
            Sign in with Plex
          </LoadingButton>
        )}
        {methods.includes("oidc") && (
          <LoadingButton
            size="sm"
            onClick={() => void run("oidc", reauthWithOidcPopup)}
            disabled={inProgress}
            loading={busy === "oidc"}
            iconClassName={SPINNER}
          >
            Sign in with SSO
          </LoadingButton>
        )}
        {methods.includes("forward") && (
          <LoadingButton
            size="sm"
            onClick={() => void run("forward", reauthWithProxy)}
            disabled={inProgress}
            loading={busy === "forward"}
            iconClassName={SPINNER}
          >
            Confirm with SSO
          </LoadingButton>
        )}
        {(plex.isLoading || busy === "oidc") && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              plex.cancel();
              attempt.current?.abort();
            }}
          >
            Cancel
          </Button>
        )}
      </div>
      {methods.includes("password") && (
        <div className="flex gap-2">
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="Current password"
            aria-label="Current password"
            value={password}
            onChange={(e) => {
              setError(null);
              setPassword(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitPassword();
              }
            }}
            disabled={inProgress}
            className="h-8"
          />
          <LoadingButton
            size="sm"
            onClick={() => void submitPassword()}
            disabled={inProgress || !password}
            loading={busy === "password"}
            iconClassName={SPINNER}
          >
            Confirm
          </LoadingButton>
        </div>
      )}
      {methods.includes("plex") && !plex.isLoading && (
        <p className="text-xs text-muted-foreground">
          Sign in to Plex with the account linked to Librariarr.
        </p>
      )}
      {busy === "oidc" && (
        <p className="text-xs text-muted-foreground">Finish signing in in the pop-up window.</p>
      )}
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
