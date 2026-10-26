"use client";

import { useState } from "react";
import { useRealtime } from "@/hooks/use-realtime";
import { createRealtimeResource, useRealtimeResource } from "@/hooks/use-realtime-resource";

export interface ServerInfo {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

// TODO(fields=basic): switch to `/api/servers?fields=basic` once the route
// offers it — the pickers read only these four fields, and the full answer
// carries every server's libraries and latest sync job.
export const SERVERS_URL = "/api/servers";

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
  url: SERVERS_URL,
  events: ["server:changed"],
  parse: parseServers,
});

export function useServers() {
  const servers = useRealtimeResource(serversResource) ?? NO_SERVERS;
  const [selectedServerId, setSelectedServerId] = useState<string>("all");

  // Adding, renaming or removing a server must reach every open picker.
  useRealtime("server:changed", serversResource.refresh);

  return { servers, selectedServerId, setSelectedServerId };
}
