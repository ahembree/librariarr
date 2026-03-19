"use client";

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, Loader2 } from "lucide-react";

interface ArrMatch {
  type: "sonarr" | "radarr" | "lidarr";
  instanceId: string;
  instanceName: string;
  qualityProfileName: string | null;
  matchedVia: string;
  externalId: string;
  tags: string[];
  arrUrl: string | null;
}

interface ArrInfoResponse {
  matches: ArrMatch[];
  plexRatingKey: string;
}

const ARR_LABELS: Record<string, string> = {
  sonarr: "Sonarr",
  radarr: "Radarr",
  lidarr: "Lidarr",
};

function getArrLabel(type: string | null, mediaType?: string): string {
  if (mediaType === "MUSIC") return "Lidarr";
  if (type) return ARR_LABELS[type] || type;
  return "Arr";
}

function ArrInstanceCard({ match, plexRatingKey }: { match: ArrMatch; plexRatingKey: string }) {
  const label = ARR_LABELS[match.type] || match.type;

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        {match.arrUrl && (
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1 px-2"
            asChild
          >
            <a href={match.arrUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3" />
              Open in {label}: {match.instanceName}
            </a>
          </Button>
        )}
      </div>
      {match.tags.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">Tags</p>
          <div className="flex flex-wrap items-center gap-2">
            {match.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="bg-muted/50">
                {tag}
              </Badge>
            ))}
          </div>
        </>
      )}

      {match.qualityProfileName && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Quality Profile</p>
          <p className="text-sm">{match.qualityProfileName}</p>
        </div>
      )}

      <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
        {match.matchedVia && match.externalId && (
          <p>Matched via {match.matchedVia} ID: {match.externalId}</p>
        )}
        {plexRatingKey && (
          <p>Plex Rating Key: {plexRatingKey}</p>
        )}
      </div>
    </div>
  );
}

export function ArrSection({ itemId, mediaType }: { itemId: string; mediaType?: string }) {
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
    return (
      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {getArrLabel(null, mediaType)}
        </h3>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading...
        </div>
      </section>
    );
  }

  if (!arrData || arrData.matches.length === 0) return null;

  // Group matches by type for the heading
  const typeLabel = getArrLabel(arrData.matches[0].type, mediaType);

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {typeLabel}
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {arrData.matches.map((match) => (
          <ArrInstanceCard
            key={match.instanceId}
            match={match}
            plexRatingKey={arrData.plexRatingKey}
          />
        ))}
      </div>
    </section>
  );
}
