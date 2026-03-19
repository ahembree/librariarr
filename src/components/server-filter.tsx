"use client";

import { Server } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ServerInfo {
  id: string;
  name: string;
}

interface ServerFilterProps {
  servers: ServerInfo[];
  value: string;
  onChange: (value: string) => void;
}

export function ServerFilter({ servers, value, onChange }: ServerFilterProps) {
  if (servers.length <= 1) return null;

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-full sm:w-50 text-sm">
        <Server className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
        <SelectValue placeholder="All Servers" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Servers</SelectItem>
        {servers.map((server) => (
          <SelectItem key={server.id} value={server.id}>
            {server.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
