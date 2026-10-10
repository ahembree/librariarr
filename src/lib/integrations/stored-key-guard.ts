import type { NextResponse } from "next/server";
import { MASKED_VALUE } from "@/lib/api/sanitize";
import { hasRecentLogin } from "@/lib/auth/recent-login";
import { reauthRequired } from "@/lib/auth/reauth";

const withoutTrailingSlash = (value: string) => value.replace(/\/+$/, "");

/**
 * Whether a request would send an integration's STORED API key to a URL other
 * than the stored one — a new `url` with no new key (absent, empty, or the
 * masked echo the settings form sends back).
 */
export function sendsStoredKeyToNewUrl(
  storedUrl: string,
  url: string | undefined,
  apiKey: string | undefined,
): boolean {
  if (url === undefined || withoutTrailingSlash(url) === withoutTrailingSlash(storedUrl)) return false;
  return apiKey === undefined || apiKey === "" || apiKey === MASKED_VALUE;
}

/**
 * Refuses, without a recent sign-in, any edit or connection test that would
 * send an integration's stored API key to a new URL.
 *
 * The `[id]` PUT and `[id]/test-connection` routes of every integration fall
 * back to the stored key when the request carries none, and the key goes out
 * with the request to whatever URL the body names. A cookie alone could
 * therefore post `{ url: "https://attacker" }` and have the server hand over a
 * Radarr/Sonarr/Lidarr key — one that deletes the whole library — or a Seerr
 * or Tracearr key. The same rule `PUT /api/servers/[id]` applies to a Plex
 * server's token (see recent-login.ts). A request that brings its own key
 * proves nothing is being handed over and is never asked.
 */
export async function refuseStoredKeyToNewUrl(
  session: { userId?: string; authenticatedAt?: number },
  storedUrl: string,
  url: string | undefined,
  apiKey: string | undefined,
  service: string,
): Promise<NextResponse | null> {
  if (!sendsStoredKeyToNewUrl(storedUrl, url, apiKey)) return null;
  if (hasRecentLogin(session)) return null;
  return reauthRequired(session.userId!, `Pointing ${service} at a new URL with its saved API key`);
}
