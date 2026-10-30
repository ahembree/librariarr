"use client";

import { useEffect, useState, useSyncExternalStore, type ComponentType } from "react";
import { createModuleLoader } from "@/lib/module-loader";
import { usePrefetchReady } from "@/components/deferred-prefetch-link";
import {
  getReauthRequest,
  registerReauthHost,
  subscribeReauth,
  type ReauthRequest,
} from "@/lib/auth/reauth-client";

// The prompt and its sign-in methods (the Plex and OIDC flows) load once the
// page is idle, or when a prompt is asked for first: mounted in the shell,
// they were part of the script every page ran before it was interactive, for
// a prompt most visits never see.
const reauthDialogModule = createModuleLoader(() => import("@/components/reauth-dialog"));

type ReauthDialogComponent = ComponentType<{ request: ReauthRequest | null }>;

/**
 * Shows the prompt `confirmIdentity` / `fetchWithReauth` ask for. Mounted
 * once, in the authenticated shell.
 */
export function ReauthDialogHost() {
  const request = useSyncExternalStore(subscribeReauth, getReauthRequest, () => null);
  // Kept mounted once loaded, so its closing animation plays.
  const [Dialog, setDialog] = useState<ReauthDialogComponent | null>(
    () => reauthDialogModule.get()?.ReauthDialog ?? null,
  );

  useEffect(() => registerReauthHost(), []);

  const prefetchReady = usePrefetchReady();
  useEffect(() => {
    if (prefetchReady) void reauthDialogModule.load().catch(() => {});
  }, [prefetchReady]);

  useEffect(() => {
    if (request === null || Dialog) return;
    let active = true;
    reauthDialogModule.load().then(
      (loaded) => {
        if (active) setDialog(() => loaded.ReauthDialog);
      },
      (error: unknown) => {
        console.error("Failed to load the confirmation prompt:", error);
        // Nothing can show it: its callers must not wait for ever. The next
        // prompt tries the load again.
        if (active) request.resolve(false);
      },
    );
    return () => {
      active = false;
    };
  }, [request, Dialog]);

  return Dialog ? <Dialog request={request} /> : null;
}
