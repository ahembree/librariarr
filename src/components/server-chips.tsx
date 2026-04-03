"use client";

import { useRef, useState, useEffect, useCallback } from "react";
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
  const containerRef = useRef<HTMLDivElement>(null);
  const measuringRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(servers.length);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const measuring = measuringRef.current;
    if (!container || !measuring) return;

    const chips = Array.from(measuring.children) as HTMLElement[];
    if (chips.length === 0) return;

    const containerWidth = container.clientWidth;
    const badgeWidth = 28;
    const gap = 4; // gap-1
    let usedWidth = 0;
    let count = 0;

    for (let i = 0; i < chips.length; i++) {
      const chipWidth = chips[i].offsetWidth;
      const totalWithChip = usedWidth + (count > 0 ? gap : 0) + chipWidth;
      if (i === chips.length - 1) {
        if (totalWithChip <= containerWidth) {
          count++;
        }
        break;
      }
      if (totalWithChip + gap + badgeWidth <= containerWidth) {
        usedWidth = totalWithChip;
        count++;
      } else {
        break;
      }
    }

    setVisibleCount(Math.max(1, count));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- depends on servers.length, not identity
  }, [servers.length]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ResizeObserver fires immediately on observe, triggering the initial measurement
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [measure]);

  if (!servers || servers.length === 0) return null;

  const overflow = servers.length - visibleCount;

  return (
    <div ref={containerRef} className="flex flex-nowrap gap-1 min-w-0 overflow-hidden">
      {/* Hidden measuring container — renders all chips for measurement */}
      <div
        ref={measuringRef}
        className="flex flex-nowrap gap-1 absolute invisible pointer-events-none"
        aria-hidden="true"
      >
        {servers.map((s) => {
          const style =
            SERVER_TYPE_STYLES[s.serverType] ?? DEFAULT_SERVER_STYLE;
          return (
            <span
              key={s.serverId}
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none border shrink-0 ${style.classes}`}
            >
              {s.serverName}
            </span>
          );
        })}
      </div>

      {/* Visible chips */}
      {servers.slice(0, visibleCount).map((s) => {
        const style =
          SERVER_TYPE_STYLES[s.serverType] ?? DEFAULT_SERVER_STYLE;
        return (
          <span
            key={s.serverId}
            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none border shrink-0 ${style.classes}`}
          >
            {s.serverName}
          </span>
        );
      })}
      {overflow > 0 && (
        <span
          className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none border border-border/50 bg-muted/50 text-muted-foreground shrink-0"
          title={servers
            .slice(visibleCount)
            .map((s) => s.serverName)
            .join(", ")}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
