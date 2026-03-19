"use client";

import { useState, useRef, useCallback, useEffect } from "react";

const POLL_INTERVAL = 2000;
const POLL_TIMEOUT = 300000; // 5 minutes
const POPUP_CHECK_INTERVAL = 1000;

interface UsePlexOAuthOptions {
  /** Called with the Plex authToken when authentication succeeds. Throw to surface an error. */
  onSuccess: (authToken: string) => Promise<void>;
  /** Called when an error occurs (optional — also sets `error` state). */
  onError?: (message: string) => void;
}

interface UsePlexOAuthReturn {
  /** Initiates the Plex OAuth flow (opens popup, starts polling). */
  startAuth: () => Promise<void>;
  /** Cancels the in-progress auth flow. */
  cancel: () => void;
  /** Whether an auth flow is in progress. */
  isLoading: boolean;
  /** Error message from the last auth attempt, or null. */
  error: string | null;
  /** The Plex auth URL (shown as fallback link when popup is blocked). */
  authUrl: string | null;
}

export function usePlexOAuth({ onSuccess, onError }: UsePlexOAuthOptions): UsePlexOAuthReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popupCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const popupRef = useRef<Window | null>(null);
  const isAuthenticatedRef = useRef(false);
  const pollFnRef = useRef<(() => void) | null>(null);

  // Stable ref for callbacks so the polling closure always sees the latest
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
    onErrorRef.current = onError;
  });

  const cleanup = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (popupCheckRef.current) clearInterval(popupCheckRef.current);
    pollRef.current = null;
    timeoutRef.current = null;
    popupCheckRef.current = null;
    pollFnRef.current = null;
  }, []);

  const handleError = useCallback((message: string) => {
    setError(message);
    onErrorRef.current?.(message);
  }, []);

  const cancel = useCallback(() => {
    if (isAuthenticatedRef.current) return;
    cleanup();
    try { popupRef.current?.close(); } catch {}
    setIsLoading(false);
    setAuthUrl(null);
  }, [cleanup]);

  // When tab becomes visible (user switching back from Plex on mobile), poll immediately.
  // Mobile browsers throttle timers while backgrounded.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && pollFnRef.current && !isAuthenticatedRef.current) {
        pollFnRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  const startAuth = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setAuthUrl(null);
    isAuthenticatedRef.current = false;

    try {
      // Open popup to our local loading page first (same-origin = reliable reference)
      const popup = window.open("/login/plex/loading", "_blank", "width=600,height=700");
      popupRef.current = popup;

      // Fetch PIN + auth URL + client credentials from our backend
      const response = await fetch("/api/auth/plex/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        try { popup?.close(); } catch {}
        const data = await response.json().catch(() => ({}));
        handleError(data.error || "Failed to start Plex authentication");
        setIsLoading(false);
        return;
      }

      const data = await response.json();
      setAuthUrl(data.authUrl);

      // Navigate the popup/tab to Plex auth page
      if (popup && !popup.closed) {
        popup.location.href = data.authUrl;
      } else {
        // Popup was blocked — show fallback link, still poll from main tab
        popupRef.current = null;
      }

      // Start polling
      cleanup();

      // Check if popup was closed by user (only cancel if auth hasn't completed)
      popupCheckRef.current = setInterval(() => {
        try {
          if (popupRef.current?.closed && !isAuthenticatedRef.current) {
            cancel();
          }
        } catch {
          // Cross-origin — can't check
        }
      }, POPUP_CHECK_INTERVAL);

      // Poll Plex directly for the authToken
      const poll = async () => {
        try {
          const pinUrl = new URL(`https://plex.tv/api/v2/pins/${data.pinId}`);
          if (data.code) pinUrl.searchParams.set("code", data.code);

          const res = await fetch(pinUrl.toString(), {
            headers: {
              Accept: "application/json",
              "X-Plex-Client-Identifier": data.clientId,
              "X-Plex-Product": data.product,
              "X-Plex-Version": data.version,
            },
          });
          const pin = await res.json();

          if (pin.authToken) {
            cleanup();
            isAuthenticatedRef.current = true;
            try { popupRef.current?.close(); } catch {}

            try {
              await onSuccessRef.current(pin.authToken);
            } catch (err) {
              isAuthenticatedRef.current = false;
              handleError(err instanceof Error ? err.message : "Authentication failed");
              setIsLoading(false);
              setAuthUrl(null);
              return;
            }

            setIsLoading(false);
            setAuthUrl(null);
          }
        } catch {
          // Network error — continue polling
        }
      };

      pollFnRef.current = poll;
      poll();
      pollRef.current = setInterval(poll, POLL_INTERVAL);

      // Timeout after 5 minutes
      timeoutRef.current = setTimeout(() => {
        cancel();
      }, POLL_TIMEOUT);
    } catch {
      setIsLoading(false);
      handleError("Failed to start Plex authentication");
    }
  }, [cleanup, cancel, handleError]);

  return { startAuth, cancel, isLoading, error, authUrl };
}
