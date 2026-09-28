"use client";

import { useEffect, useState } from "react";
import { REAUTH_CHANNEL, REAUTH_MESSAGE_TYPE } from "@/lib/auth/reauth-client";

/**
 * Where the identity-confirmation popup lands: first while the SSO sign-in is
 * being started (`?pending=1`), then from the OIDC callback with `?status=ok`
 * or `?error=<code>`. It reports to the page that opened it and closes
 * itself. The report goes out twice — to `window.opener`, and on a
 * BroadcastChannel for when an IdP's Cross-Origin-Opener-Policy has severed
 * the popup from its opener (`window.opener` is then null); the opener takes
 * whichever arrives first.
 */
export default function ReauthPage() {
  const [message, setMessage] = useState("Connecting to your sign-in provider…");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("pending")) return;
    const ok = params.get("status") === "ok";
    const report = { type: REAUTH_MESSAGE_TYPE, ok, error: params.get("error") ?? undefined };
    try {
      window.opener?.postMessage(report, window.location.origin);
    } catch {
      // No opener to tell; the channel below still reaches it.
    }
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(REAUTH_CHANNEL);
      channel.postMessage(report);
      channel.close();
    }
    window.close();
    // Still open: the browser refused to close a window it may not consider
    // script-opened any more.
    const timer = setTimeout(() => {
      setMessage(
        ok
          ? "Identity confirmed. You can close this window and continue."
          : "Couldn't confirm it's you. Close this window and try again.",
      );
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
