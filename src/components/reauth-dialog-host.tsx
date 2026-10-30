"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { lazyComponent } from "@/components/lazy-component";
import {
  getReauthRequest,
  registerReauthHost,
  subscribeReauth,
} from "@/lib/auth/reauth-client";

// The prompt and its sign-in methods (the Plex and OIDC flows) load when a
// prompt is first asked for: mounted in the shell, they were part of the
// script every page ran before it was interactive, for a prompt most visits
// never see.
const ReauthDialog = lazyComponent(
  () => import("@/components/reauth-dialog").then((m) => m.ReauthDialog),
  () => null,
);

/**
 * Shows the prompt `confirmIdentity` / `fetchWithReauth` ask for. Mounted
 * once, in the authenticated shell.
 */
export function ReauthDialogHost() {
  const request = useSyncExternalStore(subscribeReauth, getReauthRequest, () => null);
  // Kept mounted after the first prompt, so its closing animation plays.
  const [asked, setAsked] = useState(false);
  if (request !== null && !asked) setAsked(true);

  useEffect(() => registerReauthHost(), []);

  return asked ? <ReauthDialog request={request} /> : null;
}
