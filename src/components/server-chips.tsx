"use client";

import {
  SERVER_TYPE_STYLES,
  DEFAULT_SERVER_STYLE,
} from "@/lib/server-styles";

interface ServerPresenceDisplay {
  serverId: string;
  serverName: string;
  serverType: string;
}

interface ServerChipsProps {
  servers: ServerPresenceDisplay[];
}

export function ServerChips({ servers }: ServerChipsProps) {
  if (!servers || servers.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {servers.map((s) => {
        const style =
          SERVER_TYPE_STYLES[s.serverType] ?? DEFAULT_SERVER_STYLE;
        return (
          <span
            key={s.serverId}
            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none border ${style.classes}`}
          >
            {s.serverName}
          </span>
        );
      })}
    </div>
  );
}
