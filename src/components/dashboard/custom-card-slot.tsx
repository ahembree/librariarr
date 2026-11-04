"use client";

import { useEffect, useState } from "react";
import { lazyComponent } from "@/components/lazy-component";
import { ChartCardSkeleton } from "@/components/skeletons";
import { useDashboardCardDisplay } from "@/hooks/use-dashboard-card-display";
import { effectiveCardType, toggleHiddenValue, type CardDisplay, type CardMediaType } from "@/lib/dashboard/card-display";
import type { CustomCardConfig } from "@/lib/dashboard/card-registry";
import {
  customCardBatcher,
  customCardDataFrom,
  customCardRequest,
  customCardRequestKey,
  type CustomCardData,
} from "@/lib/dashboard/custom-card-data";

// Loaded on demand: it is the only dashboard card built on recharts (~500 KB
// of script), and most dashboards have no custom card at all, so importing it
// here put the whole chart library on the landing page for nothing.
const NO_HIDDEN: readonly string[] = [];

const CustomChartCard = lazyComponent(
  () => import("@/components/custom-chart-card").then((m) => m.CustomChartCard),
  ChartCardSkeleton,
);

interface CustomCardSlotProps {
  config: CustomCardConfig;
  filterType?: "MOVIE" | "SERIES" | "MUSIC";
  lockedFilterType?: boolean;
  serverId?: string;
  availableTypes?: string[];
  onEditConfig?: (config: CustomCardConfig) => void;
  /** The card's saved display choices (type pick, hidden values) and their setter; the dialog's preview keeps its own. */
  display?: CardDisplay;
  onDisplayChange?: (next: CardDisplay | undefined) => void;
}

/**
 * A custom Insights card: its type selection and its data, here, and the chart
 * (`CustomChartCard`), loaded with the chart library.
 *
 * The data is asked for here rather than by the chart so the request starts
 * with the dashboard instead of after the chart library has downloaded, and so
 * every card's request of one render goes out in one batch
 * (`customCardBatcher`). Each card keeps its own loading, failed and empty
 * states: an answer is applied only to the request it was asked for.
 */
export function CustomCardSlot({
  config,
  filterType: externalFilterType,
  lockedFilterType,
  serverId,
  availableTypes,
  onEditConfig,
  display,
  onDisplayChange,
}: CustomCardSlotProps) {
  // The card follows the Insights type selector, as the built-in cards do;
  // its own pick overrides it until the Insights one changes again. A pick of
  // a type that has since left the library is ignored (the card's selector
  // hides once one type is left, so it could not be cleared there).
  const [choices, updateChoices] = useDashboardCardDisplay(display, onDisplayChange, externalFilterType);
  const localType = effectiveCardType(choices.type, externalFilterType as CardMediaType | undefined, availableTypes);
  const localFilter = localType ?? "ALL";
  const filterType = lockedFilterType ? externalFilterType : localType;

  const request = customCardRequest(config, { serverId, filterType });
  const requestKey = customCardRequestKey(request);
  // The answer and the request it answers. Keyed so an older request's slow
  // answer never lands under an edited card's new title, and a failed load
  // shows an error rather than the previous config's data.
  const [answered, setAnswered] = useState<{ key: string; data: CustomCardData | null } | null>(null);

  useEffect(() => {
    let current = true;
    void customCardBatcher.load(request).then((answer) => {
      if (current) setAnswered({ key: requestKey, data: customCardDataFrom(request.kind, answer) });
    });
    return () => {
      current = false;
    };
    // Keyed on what is asked, not on the request object rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const answer = answered !== null && answered.key === requestKey ? answered : null;
  const loading = answer === null;
  const data = answer?.data ?? null;

  return (
    <CustomChartCard
      config={config}
      filterType={filterType}
      lockedFilterType={lockedFilterType}
      availableTypes={availableTypes}
      localFilter={localFilter}
      onLocalFilterChange={(value) => updateChoices({ type: value === "ALL" ? "ALL" : (value as CardMediaType) })}
      hidden={choices.hidden ?? NO_HIDDEN}
      onToggleHidden={(label) => updateChoices({ hidden: toggleHiddenValue(choices.hidden, label) })}
      loading={loading}
      failed={!loading && data === null}
      data={data}
      onEditConfig={onEditConfig}
    />
  );
}
