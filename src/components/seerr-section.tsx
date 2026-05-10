"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ColorChip } from "@/components/color-chip";
import { ExternalLink, Inbox, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SeerrRequestSummary {
  id: number;
  status: number;
  is4k: boolean;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SeerrMatch {
  instanceId: string;
  instanceName: string;
  matchedVia: "TMDB" | "TVDB";
  externalId: string;
  seerrUrl: string | null;
  mediaStatus: number | null;
  requests: SeerrRequestSummary[];
}

export interface SeerrInfoResponse {
  matches: SeerrMatch[];
}

const SEERR_TYPE_STYLE = {
  text: "text-violet-400",
  dot: "bg-violet-400 shadow-[0_0_6px] shadow-violet-400/60",
};

// SeerrMediaInfo.status enum: 1=UNKNOWN, 2=PENDING, 3=PROCESSING, 4=PARTIAL, 5=AVAILABLE, 6=DELETED
const MEDIA_STATUS_STYLES: Record<number, { label: string; classes: string }> = {
  1: { label: "Unknown", classes: "border-muted-foreground/30 bg-muted/40 text-muted-foreground" },
  2: { label: "Pending", classes: "border-amber-500/30 bg-amber-500/10 text-amber-400" },
  3: { label: "Processing", classes: "border-sky-500/30 bg-sky-500/10 text-sky-400" },
  4: { label: "Partial", classes: "border-blue-500/30 bg-blue-500/10 text-blue-400" },
  5: { label: "Available", classes: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" },
  6: { label: "Deleted", classes: "border-red-500/30 bg-red-500/10 text-red-400" },
};

// SeerrRequest.status enum: 1=PENDING, 2=APPROVED, 3=DECLINED
const REQUEST_STATUS_STYLES: Record<number, { label: string; classes: string }> = {
  1: { label: "Pending", classes: "border-amber-500/30 bg-amber-500/10 text-amber-400" },
  2: { label: "Approved", classes: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" },
  3: { label: "Declined", classes: "border-red-500/30 bg-red-500/10 text-red-400" },
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function summarizeRequesters(requests: SeerrRequestSummary[]): { display: string; full: string } {
  const unique = Array.from(new Set(requests.map((r) => r.requestedBy)));
  if (unique.length === 0) return { display: "—", full: "" };
  if (unique.length <= 2) return { display: unique.join(", "), full: unique.join(", ") };
  return { display: `${unique.slice(0, 2).join(", ")} +${unique.length - 2}`, full: unique.join(", ") };
}

function earliestDate(requests: SeerrRequestSummary[]): string | null {
  let earliest: string | null = null;
  for (const r of requests) {
    if (!r.createdAt) continue;
    if (!earliest || r.createdAt < earliest) earliest = r.createdAt;
  }
  return earliest;
}

function SeerrDetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/30 py-1.5 last:border-0">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="truncate text-right text-sm font-medium">{value}</span>
    </div>
  );
}

export function SeerrInstanceCard({ match }: { match: SeerrMatch }) {
  const requesters = summarizeRequesters(match.requests);
  const firstRequested = earliestDate(match.requests);
  const requestCount = match.requests.length;
  const has4k = match.requests.some((r) => r.is4k);

  // If every request has the same status, show that single status. Otherwise show "Mixed".
  const statusValues = new Set(match.requests.map((r) => r.status));
  const aggregatedRequestStatus = statusValues.size === 1 ? [...statusValues][0] : null;
  const requestStatusStyle = aggregatedRequestStatus !== null ? REQUEST_STATUS_STYLES[aggregatedRequestStatus] : null;

  const mediaStatusStyle = match.mediaStatus !== null ? MEDIA_STATUS_STYLES[match.mediaStatus] : null;

  return (
    <div className="rounded-xl border border-white/6 bg-muted/30 p-5 shadow-[inset_0_1px_0_oklch(1_0_0/3%)] space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", SEERR_TYPE_STYLE.dot)} aria-hidden />
          <p className="truncate text-sm font-semibold">{match.instanceName}</p>
        </div>
        {match.seerrUrl && (
          <Button
            variant="ghost"
            size="icon-sm"
            asChild
            title="Open in Seerr"
            className="-mr-1.5 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <a
              href={match.seerrUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${match.instanceName} in Seerr`}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        )}
      </div>

      <div className="text-sm">
        {mediaStatusStyle && (
          <SeerrDetailRow
            label="Media Status"
            value={<ColorChip className={cn("text-[10px] font-medium", mediaStatusStyle.classes)}>{mediaStatusStyle.label}</ColorChip>}
          />
        )}
        {requestStatusStyle && (
          <SeerrDetailRow
            label="Request Status"
            value={
              <span className="flex items-center justify-end gap-1.5">
                <ColorChip className={cn("text-[10px] font-medium", requestStatusStyle.classes)}>{requestStatusStyle.label}</ColorChip>
                {has4k && (
                  <ColorChip className="border-fuchsia-500/30 bg-fuchsia-500/10 text-[10px] font-medium text-fuchsia-300">
                    4K
                  </ColorChip>
                )}
              </span>
            }
          />
        )}
        <SeerrDetailRow
          label={requestCount === 1 ? "Request" : "Requests"}
          value={requestCount}
        />
        <SeerrDetailRow
          label="Requested By"
          value={<span title={requesters.full}>{requesters.display}</span>}
        />
        {firstRequested && (
          <SeerrDetailRow
            label={requestCount === 1 ? "Requested" : "First Requested"}
            value={formatDate(firstRequested)}
          />
        )}
        <SeerrDetailRow
          label={`${match.matchedVia} ID`}
          value={<span className="font-mono text-xs text-foreground/80">{match.externalId}</span>}
        />
      </div>
    </div>
  );
}

export function SeerrSection({ itemId, mediaType }: { itemId: string; mediaType?: string }) {
  const [data, setData] = useState<SeerrInfoResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setData(null);
    setLoading(true);
    (async () => {
      try {
        const response = await fetch(`/api/media/${itemId}/seerr-info`);
        const body: SeerrInfoResponse = await response.json();
        setData(body);
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [itemId]);

  // Seerr does not handle music — skip the section entirely
  if (mediaType === "MUSIC") return null;

  if (loading) {
    return (
      <section>
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <Inbox className={cn("h-3.5 w-3.5", SEERR_TYPE_STYLE.text)} />
          Seerr
        </h3>
        <div className="rounded-xl border border-white/6 bg-muted/30 p-5 shadow-[inset_0_1px_0_oklch(1_0_0/3%)]">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading request info…
          </div>
        </div>
      </section>
    );
  }

  if (!data || data.matches.length === 0) return null;

  const count = data.matches.length;

  return (
    <section>
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        <Inbox className={cn("h-3.5 w-3.5", SEERR_TYPE_STYLE.text)} />
        Seerr
        {count > 1 && (
          <span className="text-xs font-normal normal-case tracking-normal">
            ({count} instances)
          </span>
        )}
      </h3>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {data.matches.map((match) => (
          <SeerrInstanceCard key={match.instanceId} match={match} />
        ))}
      </div>
    </section>
  );
}
