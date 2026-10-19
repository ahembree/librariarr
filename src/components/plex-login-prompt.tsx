"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { fetchWithReauth } from "@/lib/auth/reauth-client";
import { readResponseError } from "@/lib/api/error-message";

/**
 * Asks, right after a Plex account is linked, whether to turn Plex sign-in on.
 * Linking never changes the setting, and a setup done with a local password
 * leaves it off, so without this the login page simply shows no Plex button.
 * Turning it on needs a recent sign-in, which linking itself just required.
 */
export function PlexLoginPrompt({
  open,
  onDone,
}: {
  open: boolean;
  /** Called when the prompt closes; `enabled` is true when Plex login was turned on. */
  onDone: (enabled: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);

  const enable = async () => {
    setSaving(true);
    try {
      const res = await fetchWithReauth("/api/settings/auth", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plexLoginEnabled: true }),
      });
      if (res.ok) {
        toast.success("Plex login enabled");
        onDone(true);
      } else {
        toast.error("Couldn't enable Plex login", {
          description: await readResponseError(res, "Turn it on under Settings → Authentication instead."),
        });
        onDone(false);
      }
    } catch {
      toast.error("Couldn't enable Plex login", { description: "Network error" });
      onDone(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !saving) onDone(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Allow signing in with Plex?</AlertDialogTitle>
          <AlertDialogDescription>
            Your Plex account is linked, but Plex login is turned off, so the login page offers no Plex
            button. Turn it on to sign in with this Plex account. Leave it off if other people share the
            Plex account — anyone who can sign in to it could then sign in to Librariarr. You can change
            this any time under Settings → Authentication.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Keep it off</AlertDialogCancel>
          <AlertDialogAction
            disabled={saving}
            onClick={(e) => {
              e.preventDefault();
              void enable();
            }}
          >
            Enable Plex login
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
