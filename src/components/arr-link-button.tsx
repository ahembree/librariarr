"use client";

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Boxes, ExternalLink, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ArrMatch {
  type: "sonarr" | "radarr" | "lidarr";
  instanceId: string;
  instanceName: string;
  qualityProfileName: string | null;
  matchedVia: string;
  externalId: string;
  tags: string[];
  arrUrl: string | null;
}

export interface ArrInfoResponse {
  matches: ArrMatch[];
}

interface ArrTypeStyle {
  label: string;
  /** Tailwind text color for icons */
  text: string;
  /** Tailwind bg color for the indicator dot, with matching glow */
  dot: string;
}

const ARR_TYPE_STYLES: Record<ArrMatch["type"], ArrTypeStyle> = {
  sonarr: { label: "Sonarr", text: "text-sky-400", dot: "bg-sky-400 shadow-[0_0_6px] shadow-sky-400/60" },
  radarr: { label: "Radarr", text: "text-amber-400", dot: "bg-amber-400 shadow-[0_0_6px] shadow-amber-400/60" },
  lidarr: { label: "Lidarr", text: "text-emerald-400", dot: "bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400/60" },
};

function getArrTypeStyle(type: string | null, mediaType?: string): ArrTypeStyle | null {
  if (mediaType === "MUSIC") return ARR_TYPE_STYLES.lidarr;
  if (type && type in ARR_TYPE_STYLES) return ARR_TYPE_STYLES[type as ArrMatch["type"]];
  return null;
}

function getArrLabel(type: string | null, mediaType?: string): string {
  return getArrTypeStyle(type, mediaType)?.label ?? "Arr";
}

function ArrDetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/30 py-1.5 last:border-0">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="truncate text-right text-sm font-medium">{value}</span>
    </div>
  );
}

export function ArrInstanceCard({ match, hideQualityProfile }: { match: ArrMatch; hideQualityProfile?: boolean }) {
  const style = ARR_TYPE_STYLES[match.type];

  return (
    <div className="rounded-xl border border-white/6 bg-muted/30 p-5 shadow-[inset_0_1px_0_oklch(1_0_0/3%)] space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", style.dot)} aria-hidden />
          <p className="truncate text-sm font-semibold">{match.instanceName}</p>
        </div>
        {match.arrUrl && (
          <Button
            variant="ghost"
            size="icon-sm"
            asChild
            title={`Open in ${style.label}`}
            className="-mr-1.5 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <a
              href={match.arrUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${match.instanceName} in ${style.label}`}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        )}
      </div>

      <div className="text-sm">
        {!hideQualityProfile && match.qualityProfileName && (
          <ArrDetailRow label="Quality Profile" value={match.qualityProfileName} />
        )}
        {match.matchedVia && match.externalId && (
          <ArrDetailRow
            label={`${match.matchedVia} ID`}
            value={<span className="font-mono text-xs text-foreground/80">{match.externalId}</span>}
          />
        )}
      </div>

      {match.tags.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Tags</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {match.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="bg-muted/50 font-normal">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ArrSection({ itemId, mediaType, hideQualityProfile }: { itemId: string; mediaType?: string; hideQualityProfile?: boolean }) {
  const [arrData, setArrData] = useState<ArrInfoResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setArrData(null);
    setLoading(true);
    (async () => {
      try {
        const response = await fetch(`/api/media/${itemId}/arr-info`);
        const data: ArrInfoResponse = await response.json();
        setArrData(data);
      } catch {
        setArrData(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [itemId]);

  if (loading) {
    const loadingStyle = getArrTypeStyle(null, mediaType);
    return (
      <section>
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <Boxes className={cn("h-3.5 w-3.5", loadingStyle?.text)} />
          {getArrLabel(null, mediaType)}
        </h3>
        <div className="rounded-xl border border-white/6 bg-muted/30 p-5 shadow-[inset_0_1px_0_oklch(1_0_0/3%)]">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading match info…
          </div>
        </div>
      </section>
    );
  }

  if (!arrData || arrData.matches.length === 0) return null;

  const headingStyle = getArrTypeStyle(arrData.matches[0].type, mediaType);
  const typeLabel = headingStyle?.label ?? "Arr";
  const count = arrData.matches.length;

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        <Boxes className={cn("h-3.5 w-3.5", headingStyle?.text)} />
        {typeLabel}
        {count > 1 && (
          <span className="text-xs font-normal normal-case tracking-normal">
            ({count} instances)
          </span>
        )}
      </h3>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {arrData.matches.map((match) => (
          <ArrInstanceCard
            key={match.instanceId}
            match={match}
            hideQualityProfile={hideQualityProfile}
          />
        ))}
      </div>
    </section>
  );
}
