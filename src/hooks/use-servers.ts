"use client";

import { useState, useEffect, useCallback } from "react";
import { useRealtime } from "@/hooks/use-realtime";

interface ServerInfo {
  id: string;
  name: string;
  type: string;
}

export function useServers() {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string>("all");

  const fetchServers = useCallback(() => {
    fetch("/api/servers")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        setServers(
          (data.servers ?? []).map(
            (s: { id: string; name: string; type: string }) => ({
              id: s.id,
              name: s.name,
              type: s.type,
            })
          )
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  // Every server mutation already emits `server:changed` and the SSE route
  // already forwards it — nothing was listening, so adding, renaming or
  // removing a server left every server picker in the app showing the old set
  // until a reload.
  useRealtime("server:changed", fetchServers);

  return { servers, selectedServerId, setSelectedServerId };
}
