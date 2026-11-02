"use client";

import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, Film, Music, Tv } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ColorChip } from "@/components/color-chip";
import type { TabNavItem } from "@/components/tab-nav";
import type { LifecycleMediaTypeTab } from "@/hooks/use-rule-set-type-filter";
import { formatActionTypeLabel } from "@/lib/lifecycle/action-types";
import { MEDIA_TYPE_BADGE_COLORS, mediaTypeLabel } from "@/lib/theme/media-type-colors";

/** The Matches and Pending pages' media-type tabs. */
export const LIFECYCLE_MEDIA_TYPE_TABS: TabNavItem<LifecycleMediaTypeTab>[] = [
  { value: "all", label: "All" },
  { value: "movies", label: "Movies", icon: Film },
  { value: "series", label: "Series", icon: Tv },
  { value: "music", label: "Music", icon: Music },
];

/** What the card's header shows of a rule set. */
export interface RuleSetGroupSummary {
  id: string;
  name: string;
  type: string;
  /** The rule set was deleted; its history remains. */
  deleted?: boolean;
  actionType?: string | null;
  targetQualityProfileId?: number | null;
  addArrTags?: string[] | null;
  removeArrTags?: string[] | null;
}

export interface RuleSetGroupCardProps {
  ruleSet: RuleSetGroupSummary;
  /** "12 matches", "3 items". */
  countLabel: string;
  expanded: boolean;
  onToggle: () => void;
  /** Show the "Action: …" line (Matches shows it only for an enabled action). */
  showAction?: boolean;
  /** More header detail after the tags: a collection, per-rule-set stats. */
  meta?: ReactNode;
  /** Buttons at the right of the header; clicks there do not toggle the card. */
  actions?: ReactNode;
  /** The card's body, rendered while expanded. */
  children?: ReactNode;
}

/**
 * One rule set's group on the Matches and Pending pages: a header that
 * expands it (name, type, count, action and tag changes, then the page's own
 * detail and buttons), and its items below while expanded.
 */
export function RuleSetGroupCard({
  ruleSet,
  countLabel,
  expanded,
  onToggle,
  showAction = true,
  meta,
  actions,
  children,
}: RuleSetGroupCardProps) {
  const addTags = ruleSet.addArrTags ?? [];
  const removeTags = ruleSet.removeArrTags ?? [];
  return (
    <Card>
      <CardHeader className="cursor-pointer" onClick={onToggle} aria-expanded={expanded}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {expanded ? (
              <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <CardTitle className="text-lg">
                {ruleSet.name}
                {ruleSet.deleted && <span className="ml-2 text-sm font-normal text-muted-foreground">(Deleted)</span>}
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2 mt-1">
                <ColorChip className={MEDIA_TYPE_BADGE_COLORS[ruleSet.type] ?? "border-border text-muted-foreground"}>
                  {mediaTypeLabel(ruleSet.type)}
                </ColorChip>
                <ColorChip className="bg-muted/40 text-muted-foreground">{countLabel}</ColorChip>
                {showAction && ruleSet.actionType && (
                  <span className="text-xs text-muted-foreground">
                    Action: {formatActionTypeLabel(ruleSet.actionType, ruleSet.targetQualityProfileId)}
                  </span>
                )}
                {(addTags.length > 0 || removeTags.length > 0) && (
                  <div className="flex flex-wrap gap-1">
                    {addTags.map((tag) => (
                      <ColorChip key={`add-${tag}`} className="bg-green/20 text-green border-green/30">
                        +{tag}
                      </ColorChip>
                    ))}
                    {removeTags.map((tag) => (
                      <ColorChip key={`rm-${tag}`} className="bg-red/20 text-red border-red/30">
                        -{tag}
                      </ColorChip>
                    ))}
                  </div>
                )}
                {meta}
              </div>
            </div>
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-2 pl-8 sm:pl-0" onClick={(e) => e.stopPropagation()}>
              {actions}
            </div>
          )}
        </div>
      </CardHeader>
      {expanded && children && <CardContent>{children}</CardContent>}
    </Card>
  );
}
