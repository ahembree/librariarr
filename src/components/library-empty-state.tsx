import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";

/**
 * A library listing with nothing to show: "No movies found." — with a Clear
 * Filters button when filters are what emptied it, else the hint to sync a
 * server.
 */
export function LibraryEmptyState({
  icon,
  noun,
  hasFilters,
  onClear,
  className,
}: {
  icon: LucideIcon;
  /** Plural, lower case: "movies", "series", "artists". */
  noun: string;
  hasFilters: boolean;
  onClear: () => void;
  className?: string;
}) {
  return (
    <EmptyState
      icon={icon}
      title={`No ${noun} found.`}
      description={hasFilters ? "Try adjusting your filters." : "Sync a media server to get started."}
      action={
        hasFilters ? (
          <Button variant="outline" size="sm" onClick={onClear}>
            Clear Filters
          </Button>
        ) : undefined
      }
      className={className}
    />
  );
}
