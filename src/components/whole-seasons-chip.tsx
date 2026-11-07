import { Layers } from "lucide-react";
import { ColorChip } from "@/components/color-chip";
import { HeldReason } from "@/components/held-actions";

/** Why a rule set's Unmonitor reaches past its matched episodes, on hover. */
export const WHOLE_SEASONS_REASON =
  "This rule set's criteria decide per season (Season Number or Seasons Behind Latest), so when every episode " +
  "of a season in your library matched, its action unmonitors that season in Sonarr whole: the season and all " +
  "of its episodes, those your library does not hold included. A season with an episode under an exception " +
  "keeps its monitoring.";

/**
 * "Whole seasons", on the Pending page's group header of a rule set whose
 * episode-scoped Unmonitor also unmonitors whole seasons (`wholeSeasons` on
 * `GET /api/lifecycle/actions`), with what that means on hover.
 */
export function WholeSeasonsChip() {
  return (
    <HeldReason reason={WHOLE_SEASONS_REASON}>
      <ColorChip className="gap-1 border-border bg-muted/40 text-muted-foreground">
        <Layers className="h-3 w-3" aria-hidden="true" />
        Whole seasons
      </ColorChip>
    </HeldReason>
  );
}
