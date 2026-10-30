"use client";

import { useState } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { createRealtimeResource, useRealtimeResource } from "@/hooks/use-realtime-resource";
import { SERVERS_URL } from "@/lib/dashboard/seed-urls";

export interface ServerInfo {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

const NO_SERVERS: ServerInfo[] = [];

function parseServers(body: unknown): ServerInfo[] {
  const servers = (body as { servers?: { id: string; name: string; type: string; enabled?: boolean }[] }).servers;
  return (servers ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    enabled: s.enabled !== false,
  }));
}

/**
 * The server list every library page's picker reads, loaded once per tab
 * instead of on every navigation (the route reads every server's libraries and
 * latest sync job), and re-read when a server changes. Every server mutation
 * emits `server:changed`.
 */
export const serversResource = createRealtimeResource<ServerInfo[]>({
  // The pickers read only these four fields (`?fields=basic`); the full answer
  // carries every server's libraries, item counts and latest sync job.
  url: SERVERS_URL,
  events: ["server:changed"],
  parse: parseServers,
});

/** `seedBody`: `GET /api/servers?fields=basic`'s body as the server render read it, if it did. */
export function useServers(seedBody?: unknown) {
  // Parsed once: the store takes the seed on mount only.
  const [seed] = useState(() => (seedBody === undefined ? null : parseServers(seedBody)));
  const servers = useRealtimeResource(serversResource, seed) ?? NO_SERVERS;
  const [selectedServerId, setSelectedServerId] = useState<string>("all");

  // Adding, renaming or removing a server must reach every open picker.
  useRealtime("server:changed", serversResource.refresh);

  return { servers, selectedServerId, setSelectedServerId };
}
