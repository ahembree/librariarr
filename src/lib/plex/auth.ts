import { randomUUID } from "crypto";
import axios from "axios";
import { prisma } from "@/lib/db";
import type { PlexPin, PlexUser, PlexResource } from "./types";

export const PLEX_PRODUCT = "Librariarr";
export const PLEX_VERSION = "0.1.0";

let cachedClientId: string | null = null;

export async function getPlexClientId(): Promise<string> {
  if (cachedClientId) return cachedClientId;

  const config = await prisma.systemConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", plexClientId: randomUUID() },
    update: {},
  });

  cachedClientId = config.plexClientId;
  return config.plexClientId;
}

async function getHeaders() {
  const clientId = await getPlexClientId();
  return {
    "X-Plex-Product": PLEX_PRODUCT,
    "X-Plex-Version": PLEX_VERSION,
    "X-Plex-Client-Identifier": clientId,
    Accept: "application/json",
  };
}

export async function createPlexPin(): Promise<PlexPin> {
  const response = await axios.post(
    "https://plex.tv/api/v2/pins",
    { strong: true },
    { headers: await getHeaders() }
  );
  return response.data;
}

export async function checkPlexPin(pinId: number, code?: string): Promise<PlexPin> {
  const response = await axios.get(`https://plex.tv/api/v2/pins/${pinId}`, {
    headers: await getHeaders(),
    params: code ? { code } : undefined,
  });
  return response.data;
}

export async function getPlexUser(authToken: string): Promise<PlexUser> {
  const response = await axios.get("https://plex.tv/api/v2/user", {
    headers: {
      ...(await getHeaders()),
      "X-Plex-Token": authToken,
    },
  });
  return response.data;
}

export async function getPlexResources(
  authToken: string
): Promise<PlexResource[]> {
  const response = await axios.get("https://plex.tv/api/v2/resources", {
    headers: {
      ...(await getHeaders()),
      "X-Plex-Token": authToken,
    },
    params: { includeHttps: 1, includeRelay: 0 },
  });
  return response.data;
}

export async function getPlexFriends(
  authToken: string
): Promise<string[]> {
  try {
    const response = await axios.get("https://plex.tv/api/v2/friends", {
      headers: {
        ...(await getHeaders()),
        "X-Plex-Token": authToken,
      },
    });
    // Response is an array of friend objects. Prefer `friendlyName`: when a user
    // sets a Plex "Full Name", that is the display title Plex reports for them in
    // session data (`/status/sessions` -> User@title, which is what the stream
    // manager's excluded-users list is matched against). `username`/`title` hold
    // the login username instead, so returning those meant a friend with a
    // friendly name set could never be excluded — the name in the picker never
    // matched the name on their session. `friendlyName` is absent/empty when
    // unset, so fall back to `title`/`username` (which Plex equates for accounts
    // without a friendly name, and which is all a managed/home user has).
    return (
      response.data as {
        username?: string;
        title?: string;
        friendlyName?: string;
      }[]
    )
      .map((f) => f.friendlyName || f.title || f.username || "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function getPlexAuthUrl(pinCode: string): Promise<string> {
  const clientId = await getPlexClientId();
  const params = new URLSearchParams({
    clientID: clientId,
    code: pinCode,
    "context[device][product]": PLEX_PRODUCT,
    "context[device][version]": PLEX_VERSION,
  });
  return `https://app.plex.tv/auth#?${params.toString()}`;
}
