"use client";

import { useState, useCallback } from "react";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { MediaHoverPopover, type MediaHoverData } from "@/components/media-hover-popover";

interface LazyMediaHoverPopoverProps {
  children: React.ReactNode;
  fetchUrl: string;
  extractData: (json: unknown) => MediaHoverData;
  placeholder: MediaHoverData;
  imageUrl?: string;
  imageAspect?: "poster" | "square";
}

export function LazyMediaHoverPopover({
  children,
  fetchUrl,
  extractData,
  placeholder,
  imageUrl,
  imageAspect,
}: LazyMediaHoverPopoverProps) {
  const [data, setData] = useState<MediaHoverData | null>(null);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open || data || loading || errored) return;
      setLoading(true);
      fetch(fetchUrl)
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();
          setData(extractData(json));
        })
        .catch(() => setErrored(true))
        .finally(() => setLoading(false));
    },
    [data, loading, errored, fetchUrl, extractData],
  );

  return (
    <HoverCard openDelay={400} closeDelay={150} onOpenChange={handleOpenChange}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="w-72 p-0 duration-200"
      >
        <MediaHoverPopover
          data={data ?? placeholder}
          imageUrl={imageUrl}
          imageAspect={imageAspect}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
