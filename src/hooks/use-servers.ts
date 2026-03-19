"use client";

import { useState, useEffect } from "react";

interface ServerInfo {
  id: string;
  name: string;
  type: string;
}

export function useServers() {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string>("all");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/servers")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
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
    return () => {
      cancelled = true;
    };
  }, []);

  return { servers, selectedServerId, setSelectedServerId };
}
