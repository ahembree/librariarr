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

interface PlexFriend {
  username?: string;
  title?: string;
  friendlyName?: string;
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

    // The v2 friends endpoint wraps the list in an object: `{ users: [...] }`.
    // The old code mapped over `response.data` directly, so `.map` threw (the
    // payload is an object, not an array), the throw was swallowed by the catch
    // below, and NO friends ever reached the excluded-users picker — it only
    // ever listed the owner and whoever happened to be streaming at that moment.
    // Unwrap `users`, and still accept a bare array in case a deployment or
    // future revision returns one.
    const data = response.data as { users?: PlexFriend[] } | PlexFriend[] | null;
    const friends: PlexFriend[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.users)
        ? data.users
        : [];

    // Prefer the display name. Plex reports a user's friendly/display title in
    // session data (`/status/sessions` -> User@title), which is what the stream
    // manager matches excluded users against — not the login `username`. Fall
    // back through `title` to `username` (Plex equates the two for accounts with
    // no friendly name, and `title` is all a managed/home user has).
    return friends
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
