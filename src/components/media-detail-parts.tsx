import { Skeleton } from "@/components/ui/skeleton";
import { RatingChip } from "@/components/rating-chip";
import { ColorChip } from "@/components/color-chip";
import { ratingChipsOf, type RatedValues } from "@/lib/media/rating-chips";

/**
 * A detail page before it has an item to show: the skeleton while its record
 * loads, then "<Thing> not found" when there was none.
 *
 * ```tsx
 * if (loading || !item) return <DetailPageStates loading={loading} notFoundLabel="Movie not found" />;
 * ```
 */
export function DetailPageStates({ loading, notFoundLabel }: { loading: boolean; notFoundLabel: string }) {
  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] w-full rounded-lg" />
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center min-h-[50dvh]">
      <p className="text-muted-foreground">{notFoundLabel}</p>
    </div>
  );
}

interface RatedItem extends RatedValues {
  library?: { mediaServer?: { type?: string | null } | null } | null;
}

/**
 * An item's ratings — the hero's `ratings` slot, the chips `ratingChipsOf`
 * lists (src/lib/media/rating-chips.ts, shared with the hover popover and the
 * Stream Manager). `serverType` defaults to the item's library's server.
 *
 * `providers={false}` leaves the per-provider scores out: the show page's
 * record is one of its episodes, whose scores are that episode's, not the show's.
 */
export function RatingChips({
  item,
  providers = true,
  serverType,
  className,
}: {
  item: RatedItem;
  providers?: boolean;
  serverType?: string | null;
  className?: string;
}) {
  const chips = ratingChipsOf(item, serverType ?? item.library?.mediaServer?.type, { providers });
  return (
    <>
      {chips.map((chip) => (
        <RatingChip key={chip.key} label={chip.label} value={chip.value} className={className} />
      ))}
    </>
  );
}

/**
 * An item's genres as hero chips, or `undefined` when it has none — so it
 * drops straight into the hero's `genres` slot, which hides when empty.
 */
export function genreChips(genres: readonly string[] | null | undefined) {
  if (!genres || genres.length === 0) return undefined;
  return <GenreChips genres={genres} />;
}

export function GenreChips({ genres }: { genres: readonly string[] }) {
  return (
    <>
      {genres.map((genre) => (
        <ColorChip key={genre} className="bg-white/10 text-white/80 border-white/20">
          {genre}
        </ColorChip>
      ))}
    </>
  );
}
