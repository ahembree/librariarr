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
    <div className="flex items-center justify-center min-h-[50dvh]">
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
  imdbRating?: number | null;
  tmdbRating?: number | null;
  rtCriticRating?: number | null;
  rtAudienceRating?: number | null;
  library?: { mediaServer?: { type?: string | null } | null } | null;
}

/** A Plex rating image naming a provider stored in its own column. */
const PROVIDER_IMAGE = /^(imdb|themoviedb|rottentomatoes):\/\//i;

/**
 * An item's ratings — the hero's `ratings` slot: each provider's score from
 * Plex (IMDb, TMDB, Rotten Tomatoes critics and audience), then the server's
 * critic and audience ratings when they come from another source (Jellyfin,
 * Emby, an item synced before the per-provider columns), then the user's own.
 *
 * `providers={false}` leaves the per-provider scores out: the show page's
 * record is one of its episodes, whose scores are that episode's, not the show's.
 */
export function RatingChips({ item, providers = true }: { item: RatedItem; providers?: boolean }) {
  const serverType = item.library?.mediaServer?.type ?? undefined;
  const hasProviders = providers && (
    item.imdbRating != null || item.tmdbRating != null ||
    item.rtCriticRating != null || item.rtAudienceRating != null);
  const showServerRating = (image: string | null | undefined) =>
    !hasProviders || !image || !PROVIDER_IMAGE.test(image);
  return (
    <>
      {providers && item.imdbRating != null && <RatingChip label="IMDb" value={item.imdbRating} />}
      {providers && item.rtCriticRating != null && (
        <RatingChip label="RT Critics" value={item.rtCriticRating} />
      )}
      {providers && item.rtAudienceRating != null && (
        <RatingChip label="RT Audience" value={item.rtAudienceRating} />
      )}
      {providers && item.tmdbRating != null && <RatingChip label="TMDB" value={item.tmdbRating} />}
      {item.rating != null && showServerRating(item.ratingImage) && (
        <RatingChip label={getRatingLabel(item.ratingImage, serverType, "rating", "Critic")} value={item.rating} />
      )}
      {item.audienceRating != null && showServerRating(item.audienceRatingImage) && (
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
