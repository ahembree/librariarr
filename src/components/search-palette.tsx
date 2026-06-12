"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Film, Tv, Music, Disc3, Search, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { FadeImage } from "@/components/ui/fade-image";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

interface SearchResult {
  id: string;
  title: string;
  parentTitle?: string | null;
  year?: number | null;
  type: "MOVIE" | "SERIES" | "MUSIC";
  scope: "individual" | "series" | "artist" | "album";
  itemCount?: number;
}

interface Results {
  movies: SearchResult[];
  series: SearchResult[];
  artists: SearchResult[];
  albums: SearchResult[];
}

const EMPTY_RESULTS: Results = { movies: [], series: [], artists: [], albums: [] };

const SCOPE_ICONS: Record<SearchResult["scope"], LucideIcon> = {
  individual: Film,
  series: Tv,
  artist: Music,
  album: Disc3,
};

/** Where a result navigates, by scope (series ids are representative
 *  episode mediaItemIds — the show route's contract). */
function resultHref(r: SearchResult): string {
  switch (r.scope) {
    case "series":
      return `/library/series/show/${r.id}`;
    case "artist":
      return `/library/music/artist/${r.id}`;
    case "album":
      return `/library/music/album/${r.id}`;
    default:
      return `/library/movies/${r.id}`;
  }
}

/** Poster / cover art via the media image proxy. Grouped scopes resolve
 *  through a representative member, so prefer the parent's artwork. */
function resultThumbSrc(r: SearchResult): string {
  const parent = r.scope === "series" || r.scope === "artist" ? "?type=parent" : "";
  return `/api/media/${r.id}/image${parent}`;
}

function ResultThumb({ result }: { result: SearchResult }) {
  const Icon = SCOPE_ICONS[result.scope];
  const square = result.scope === "artist" || result.scope === "album";
  return (
    <span
      className={`relative grid shrink-0 place-items-center overflow-hidden bg-surface-2 ring-1 ring-white/10 ${
        square ? "h-9 w-9 rounded-md" : "h-[42px] w-7 rounded-[4px]"
      }`}
    >
      <Icon className="h-3.5 w-3.5 text-faint" />
      <FadeImage
        src={resultThumbSrc(result)}
        alt=""
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover"
        onError={(e) => {
          // Keep the type icon visible instead of a broken-image glyph
          e.currentTarget.style.display = "none";
        }}
      />
    </span>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-[4px] border border-border bg-surface-2 px-1 py-px font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * Global title search (sidebar pill / ⌘K): one query across movies,
 * grouped series, artists, and albums via the existing search API —
 * selecting a result jumps straight to its detail page.
 */
export function SearchPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Anchored near the top (palette convention) so the dialog grows
          downward instead of jumping around center as results change */}
      <DialogContent
        className="top-[16%] translate-y-0 overflow-hidden p-0 sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Search library</DialogTitle>
          <DialogDescription>
            Search every movie, series, artist, and album by title.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted fresh on each open (Radix unmounts closed content), so
            query state never needs an explicit reset */}
        <PaletteBody onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results>(EMPTY_RESULTS);
  const [loading, setLoading] = useState(false);
  const reqToken = useRef(0);

  // Adjust-state-during-render idiom: flip to loading as soon as the
  // query changes, clear results the moment it empties.
  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    if (query.trim()) {
      setLoading(true);
    } else {
      setResults(EMPTY_RESULTS);
      setLoading(false);
    }
  }

  // Debounced cross-type search; token guards out-of-order responses
  // (bumped on every change so emptying the query also voids in-flight fetches)
  useEffect(() => {
    const token = ++reqToken.current;
    const q = query.trim();
    if (!q) return;
    const timeout = setTimeout(async () => {
      const fetchType = (params: string) =>
        fetch(`/api/media/search?q=${encodeURIComponent(q)}&${params}`)
          .then((res) => (res.ok ? res.json() : { items: [] }))
          .then((data) => (data.items ?? []) as SearchResult[])
          .catch(() => [] as SearchResult[]);

      const [movies, series, music] = await Promise.all([
        fetchType("type=MOVIE"),
        fetchType("type=SERIES&seriesScope=true"),
        fetchType("type=MUSIC&musicScope=true"),
      ]);
      if (token !== reqToken.current) return;
      // Movies arrive per-copy (one row per server) — series/artists/albums
      // are already grouped by the API. Collapse duplicates by title+year.
      const seenMovies = new Set<string>();
      setResults({
        movies: movies
          .filter((m) => {
            const key = `${m.title}::${m.year ?? ""}`;
            if (seenMovies.has(key)) return false;
            seenMovies.add(key);
            return true;
          })
          .slice(0, 6),
        series: series.slice(0, 6),
        artists: music.filter((m) => m.scope === "artist").slice(0, 4),
        albums: music.filter((m) => m.scope === "album").slice(0, 4),
      });
      setLoading(false);
    }, 250);
    return () => clearTimeout(timeout);
  }, [query]);

  const go = (r: SearchResult) => {
    onOpenChange(false);
    router.push(resultHref(r));
  };

  const hasQuery = query.trim().length > 0;
  const totalResults =
    results.movies.length + results.series.length + results.artists.length + results.albums.length;
  const hasResults = totalResults > 0;

  return (
    // Async results — disable cmdk's built-in filtering
    <Command
      shouldFilter={false}
      className="**:data-[slot=command-input-wrapper]:h-[52px] **:data-[slot=command-input-wrapper]:gap-2.5 **:data-[slot=command-input-wrapper]:px-4 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-faint [&_[cmdk-group]]:px-2 [&_[cmdk-item]]:gap-2.5 [&_[cmdk-item]]:rounded-md [&_[cmdk-item]]:px-2.5"
    >
      <CommandInput
        placeholder="Search movies, series, artists, albums…"
        value={query}
        onValueChange={setQuery}
        // The global *:focus-visible ring boxes the input awkwardly inside
        // the dialog — focus is already unambiguous here, so suppress it.
        // text-base below sm: anything under 16px makes iOS Safari zoom the
        // whole page when the input focuses.
        className="h-[52px] text-base focus-visible:shadow-none sm:text-[15px]"
      />
      {/* Zero-height anchor: the activity bar pulses over the divider while
          fetching, with no layout shift in either state */}
      <div className="relative">
        <div
          className={`absolute inset-x-0 -top-px h-[2px] transition-opacity ${
            loading ? "animate-pulse bg-primary/70 opacity-100" : "opacity-0"
          }`}
        />
      </div>
      <CommandList className="max-h-[min(420px,60dvh)]">
        {!hasQuery ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-surface-2 text-faint">
              <Search className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-medium">Search your library</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Movies, series, artists, and albums — by title.
              </p>
            </div>
          </div>
        ) : !hasResults && !loading ? (
          // Not CommandEmpty: the ever-present Advanced item means cmdk
          // never considers the list empty, so render the state directly.
          <div className="px-6 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              No matches for &quot;{query.trim()}&quot;
            </p>
            <p className="mt-1 text-xs text-faint">
              Check the spelling, or try the Query workspace below.
            </p>
          </div>
        ) : null}

        {results.movies.length > 0 && (
          <CommandGroup heading="Movies">
            {results.movies.map((r) => (
              <CommandItem key={`movie-${r.id}`} value={`movie-${r.id}`} onSelect={() => go(r)}>
                <ResultThumb result={r} />
                <span className="min-w-0 truncate font-medium">{r.title}</span>
                {r.year && (
                  <span className="ml-auto shrink-0 font-mono text-xs text-faint">{r.year}</span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {results.series.length > 0 && (
          <CommandGroup heading="Series">
            {results.series.map((r) => (
              <CommandItem key={`series-${r.id}`} value={`series-${r.id}`} onSelect={() => go(r)}>
                <ResultThumb result={r} />
                <span className="min-w-0 truncate font-medium">{r.title}</span>
                {r.itemCount != null && (
                  <span className="ml-auto shrink-0 font-mono text-xs text-faint">
                    {r.itemCount} ep{r.itemCount === 1 ? "" : "s"}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {results.artists.length > 0 && (
          <CommandGroup heading="Artists">
            {results.artists.map((r) => (
              <CommandItem key={`artist-${r.id}`} value={`artist-${r.id}`} onSelect={() => go(r)}>
                <ResultThumb result={r} />
                <span className="min-w-0 truncate font-medium">{r.title}</span>
                {r.itemCount != null && (
                  <span className="ml-auto shrink-0 font-mono text-xs text-faint">
                    {r.itemCount} track{r.itemCount === 1 ? "" : "s"}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {results.albums.length > 0 && (
          <CommandGroup heading="Albums">
            {results.albums.map((r) => (
              <CommandItem key={`album-${r.id}`} value={`album-${r.id}`} onSelect={() => go(r)}>
                <ResultThumb result={r} />
                <span className="min-w-0 truncate font-medium">{r.title}</span>
                {r.parentTitle && (
                  <span className="ml-auto shrink-0 truncate font-mono text-xs text-faint">
                    {r.parentTitle}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandSeparator />
        <CommandGroup heading="Advanced">
          <CommandItem
            value="open-query-workspace"
            onSelect={() => {
              onOpenChange(false);
              router.push("/library/query");
            }}
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-surface-2 ring-1 ring-white/10">
              <SlidersHorizontal className="h-3.5 w-3.5 text-faint" />
            </span>
            <span className="font-medium">Open the Query workspace</span>
            <span className="ml-auto shrink-0 font-mono text-xs text-faint">filters &amp; bulk actions</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>

      {/* Keyboard hints + result count */}
      <div className="flex items-center justify-between gap-3 border-t bg-surface-0/60 px-4 py-2">
        <span className="font-mono text-[10.5px] text-faint">
          {hasQuery && hasResults && !loading
            ? `${totalResults} result${totalResults === 1 ? "" : "s"}`
            : ""}
        </span>
        <div className="flex items-center gap-3 text-[11px] text-faint">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> open
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </div>
    </Command>
  );
}
