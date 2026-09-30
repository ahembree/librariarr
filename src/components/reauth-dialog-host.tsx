"use client";

import { useEffect, useSyncExternalStore } from "react";
import { ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ReauthPanel } from "@/components/reauth-panel";
import {
  getReauthRequest,
  registerReauthHost,
  subscribeReauth,
} from "@/lib/auth/reauth-client";

/**
 * Shows the prompt `confirmIdentity` / `fetchWithReauth` ask for. Mounted
 * once, in the authenticated shell.
 */
export function ReauthDialogHost() {
  const request = useSyncExternalStore(subscribeReauth, getReauthRequest, () => null);

  useEffect(() => registerReauthHost(), []);

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) request?.resolve(false);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Confirm it&rsquo;s you
          </DialogTitle>
          <DialogDescription>
            This change adds a lasting way into your account, so it needs a sign-in from the last
            15 minutes. Sign in again here and it goes ahead — you stay signed in.
          </DialogDescription>
        </DialogHeader>
        {request && (
          <ReauthPanel
            key={request.id}
            methods={request.methods}
            onConfirmed={() => request.resolve(true)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
