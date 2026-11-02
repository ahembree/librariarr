"use client";

import { useState, useCallback } from "react";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { MediaHoverPopover, type MediaHoverData } from "@/components/media-hover-popover";
import { detailPrefetch } from "@/lib/media/detail-prefetch";

interface LazyMediaHoverPopoverProps {
  children: React.ReactNode;
  fetchUrl: string;
  extractData: (json: unknown) => MediaHoverData;
  placeholder: MediaHoverData;
  imageUrl?: string;
  imageAspect?: "poster" | "square";
}

/**
 * A hover card that fetches its item on first open. It reads through
 * `detailPrefetch.peek`, which keeps the answer: a click that follows the
 * hover (the detail panel, the item's page) takes the record it already
 * fetched instead of asking for it again.
 */
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
      detailPrefetch
        .peek(fetchUrl)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setData(extractData(res.body));
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
