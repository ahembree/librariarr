"use client";

import { useEffect, useState } from "react";
import { Loader2, Plug } from "lucide-react";
import { ArrInstanceCard, type ArrInfoResponse, type ArrMatch } from "@/components/arr-link-button";
import { SeerrInstanceCard, type SeerrInfoResponse, type SeerrMatch } from "@/components/seerr-section";
import { cn } from "@/lib/utils";

interface IntegrationsSectionProps {
  itemId: string;
  mediaType?: string;
  hideQualityProfile?: boolean;
  /** Compact mode for side panels: force single-column grid */
  compact?: boolean;
}

interface IntegrationsData {
  arrMatches: ArrMatch[];
  seerrMatches: SeerrMatch[];
}

export function IntegrationsSection({ itemId, mediaType, hideQualityProfile, compact }: IntegrationsSectionProps) {
  const [data, setData] = useState<IntegrationsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setData(null);
    setLoading(true);
    (async () => {
      try {
        const isMusic = mediaType === "MUSIC";
        const [arrRes, seerrRes] = await Promise.all([
          fetch(`/api/media/${itemId}/arr-info`)
            .then((r) => r.json() as Promise<ArrInfoResponse>)
            .catch(() => ({ matches: [] as ArrMatch[] })),
          isMusic
            ? Promise.resolve({ matches: [] as SeerrMatch[] } satisfies SeerrInfoResponse)
            : fetch(`/api/media/${itemId}/seerr-info`)
                .then((r) => r.json() as Promise<SeerrInfoResponse>)
                .catch(() => ({ matches: [] as SeerrMatch[] })),
        ]);

        setData({
          arrMatches: arrRes.matches ?? [],
          seerrMatches: seerrRes.matches ?? [],
        });
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [itemId, mediaType]);

  const arrMatches = data?.arrMatches ?? [];
  const seerrMatches = data?.seerrMatches ?? [];
  const totalCount = arrMatches.length + seerrMatches.length;

  if (loading) {
    return (
      <section>
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <Plug className="h-3.5 w-3.5" />
          Integrations
        </h3>
        <div className="rounded-xl border border-white/6 bg-muted/30 p-5 shadow-[inset_0_1px_0_oklch(1_0_0/3%)]">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading integration matches…
          </div>
        </div>
      </section>
    );
  }

  if (totalCount === 0) return null;

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        <Plug className="h-3.5 w-3.5" />
        Integrations
        {totalCount > 1 && (
          <span className="text-xs font-normal normal-case tracking-normal">
            ({totalCount} matches)
          </span>
        )}
      </h3>
      <div className={cn("grid gap-4", compact ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2 xl:grid-cols-4")}>
        {arrMatches.map((match) => (
          <ArrInstanceCard
            key={`arr-${match.instanceId}`}
            match={match}
            hideQualityProfile={hideQualityProfile}
          />
        ))}
        {seerrMatches.map((match) => (
          <SeerrInstanceCard key={`seerr-${match.instanceId}`} match={match} />
        ))}
      </div>
    </section>
  );
}
