import { Skeleton } from "@/components/ui/skeleton";
import { RatingChip } from "@/components/rating-chip";
import { ColorChip } from "@/components/color-chip";
import { getRatingLabel } from "@/lib/rating-labels";

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
    <div className="flex items-center justify-center min-h-[50vh]">
      <p className="text-muted-foreground">{notFoundLabel}</p>
    </div>
  );
}

interface RatedItem {
  rating?: number | null;
  ratingImage?: string | null;
  audienceRating?: number | null;
  audienceRatingImage?: string | null;
  userRating?: number | null;
  library?: { mediaServer?: { type?: string | null } | null } | null;
}

/**
 * An item's critic, audience and own ratings, each labelled by the source its
 * server reports (Rotten Tomatoes, IMDb, …) — the hero's `ratings` slot.
 */
export function RatingChips({ item }: { item: RatedItem }) {
  const serverType = item.library?.mediaServer?.type ?? undefined;
  return (
    <>
      {item.rating != null && (
        <RatingChip label={getRatingLabel(item.ratingImage, serverType, "rating", "Critic")} value={item.rating} />
      )}
      {item.audienceRating != null && (
        <RatingChip
          label={getRatingLabel(item.audienceRatingImage, serverType, "audienceRating", "Audience")}
          value={item.audienceRating}
        />
      )}
      {item.userRating != null && <RatingChip label="You" value={item.userRating} />}
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
