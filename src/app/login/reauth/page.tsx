"use client";

import { useEffect, useState } from "react";
import { REAUTH_MESSAGE_TYPE } from "@/lib/auth/reauth-client";

/**
 * Where the identity-confirmation popup lands: first while the SSO sign-in is
 * being started (`?pending=1`), then from the OIDC callback with `?status=ok`
 * or `?error=<code>`. It tells the page that opened it and closes itself.
 */
export default function ReauthPage() {
  const [message, setMessage] = useState("Connecting to your sign-in provider…");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("pending")) return;
    const ok = params.get("status") === "ok";
    const error = params.get("error") ?? undefined;
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: REAUTH_MESSAGE_TYPE, ok, error }, window.location.origin);
      window.close();
    }
    // Still open: no opener to tell, or the browser refused to close it.
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
