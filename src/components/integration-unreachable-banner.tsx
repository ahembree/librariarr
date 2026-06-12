"use client";

import { AlertTriangle } from "lucide-react";
import type { ArrType, IntegrationsHealth } from "@/hooks/use-integrations-health";
import { deriveIntegrationsStatus } from "@/hooks/use-integrations-health";

interface Props {
  health: IntegrationsHealth;
  /** Whether the surrounding rules/queries reference Arr criteria. */
  hasArrRules: boolean;
  /** Whether the surrounding rules/queries reference Seerr criteria. */
  hasSeerrRules: boolean;
  /**
   * Which Arr types are relevant for this surface. SERIES rule sets only
   * care about Sonarr; MOVIE about Radarr; MUSIC about Lidarr. Ignored if
   * `arrInstanceIds` is provided (which is more specific).
   */
  relevantArrTypes?: readonly ArrType[];
  /**
   * The specific Arr instance IDs that this surface depends on. Pass the
   * rule set's `arrInstanceId` (one element) or the query page's selected
   * Arr server IDs (one or more). Empty array → no Arr instances checked.
   * Undefined → fall back to `relevantArrTypes`.
   */
  arrInstanceIds?: readonly string[];
  /** Same as `arrInstanceIds` but for Seerr. */
  seerrInstanceIds?: readonly string[];
  /** Optional override for the leading sentence (e.g. "These rules" vs "This query"). */
  subjectLabel?: string;
}

/**
 * Page-level warning banner shown when rules/queries reference an integration
 * that is configured but currently unreachable. Kept silent when the
 * integration is reachable or simply not referenced.
 *
 * The "not configured at all" case is handled by separate orphan-rule
 * warnings on each page — this component only addresses connectivity.
 */
export function IntegrationUnreachableBanner({
  health,
  hasArrRules,
  hasSeerrRules,
  relevantArrTypes,
  arrInstanceIds,
  seerrInstanceIds,
  subjectLabel = "These rules",
}: Props) {
  const status = deriveIntegrationsStatus(health, {
    relevantArrTypes,
    arrInstanceIds,
    seerrInstanceIds,
  });

  const arrIssue = hasArrRules && status.arrUnreachable;
  const seerrIssue = hasSeerrRules && status.seerrUnreachable;

  if (!arrIssue && !seerrIssue) return null;

  return (
    <div className="flex items-start gap-2 rounded-md border border-amber/30 bg-amber/10 p-3 text-sm">
      <AlertTriangle className="h-4 w-4 mt-0.5 text-amber shrink-0" />
      <div className="space-y-1">
        <p className="font-medium text-amber">
          Integration unreachable — criteria may not evaluate correctly
        </p>
        {arrIssue && (
          <p className="text-muted-foreground">
            {subjectLabel} reference Arr criteria, but the configured Arr
            integration{status.unreachableArrNames.length === 1 ? "" : "s"}{" "}
            <span className="font-medium">{status.unreachableArrNames.join(", ")}</span>{" "}
            cannot be reached right now. Until connectivity is restored, items
            requiring Arr lookups will not match.
          </p>
        )}
        {seerrIssue && (
          <p className="text-muted-foreground">
            {subjectLabel} reference Seerr criteria, but the configured Seerr
            integration{status.unreachableSeerrNames.length === 1 ? "" : "s"}{" "}
            <span className="font-medium">{status.unreachableSeerrNames.join(", ")}</span>{" "}
            cannot be reached right now. Until connectivity is restored, items
            requiring Seerr lookups will not match.
          </p>
        )}
      </div>
    </div>
  );
}
