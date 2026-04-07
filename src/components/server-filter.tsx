"use client";

import { Server } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SERVER_TYPE_STYLES } from "@/lib/server-styles";

interface ServerInfo {
  id: string;
  name: string;
  type?: string;
}

interface ServerFilterProps {
  servers: ServerInfo[];
  value: string;
  onChange: (value: string) => void;
}

export function ServerFilter({ servers, value, onChange }: ServerFilterProps) {
  if (servers.length <= 1) return null;

  // Detect duplicate names to disambiguate with server type
  const nameCounts = new Map<string, number>();
  for (const s of servers) {
    nameCounts.set(s.name, (nameCounts.get(s.name) ?? 0) + 1);
  }

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-full sm:w-50 text-sm">
        <Server className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
        <SelectValue placeholder="All Servers" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Servers</SelectItem>
        {servers.map((server) => {
          const isDuplicate = (nameCounts.get(server.name) ?? 0) > 1;
          const typeLabel = server.type
            ? (SERVER_TYPE_STYLES[server.type]?.label ?? server.type)
            : undefined;
          return (
            <SelectItem key={server.id} value={server.id}>
              {server.name}
              {isDuplicate && typeLabel && (
                <span className="ml-1.5 text-muted-foreground">({typeLabel})</span>
              )}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
