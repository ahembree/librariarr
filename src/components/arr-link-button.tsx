"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
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
