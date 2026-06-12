"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Film, Tv, Music, Disc3, SlidersHorizontal } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
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
  const hasResults =
    results.movies.length > 0 ||
    results.series.length > 0 ||
    results.artists.length > 0 ||
    results.albums.length > 0;

  return (
    // Async results — disable cmdk's built-in filtering
    <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-faint [&_[cmdk-group]]:px-2">
      <CommandInput
        placeholder="Search movies, series, artists, albums…"
        value={query}
        onValueChange={setQuery}
      />
      {/* Thin activity bar instead of a layout-shifting spinner */}
      <div className={`h-px transition-opacity ${loading ? "animate-pulse bg-primary/60 opacity-100" : "opacity-0"}`} />
      <CommandList className="max-h-[min(420px,60dvh)]">
        {!hasQuery ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Type to search your library by title.
          </div>
        ) : !hasResults && !loading ? (
          <CommandEmpty>No matches for &quot;{query.trim()}&quot;.</CommandEmpty>
        ) : null}

        {results.movies.length > 0 && (
          <CommandGroup heading="Movies">
            {results.movies.map((r) => (
              <CommandItem key={`movie-${r.id}`} value={`movie-${r.id}`} onSelect={() => go(r)}>
                <Film className="text-muted-foreground" />
                <span className="min-w-0 truncate">{r.title}</span>
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
                <Tv className="text-muted-foreground" />
                <span className="min-w-0 truncate">{r.title}</span>
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
                <Music className="text-muted-foreground" />
                <span className="min-w-0 truncate">{r.title}</span>
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
                <Disc3 className="text-muted-foreground" />
                <span className="min-w-0 truncate">{r.title}</span>
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
            <SlidersHorizontal className="text-muted-foreground" />
            Open the Query workspace
            <span className="ml-auto shrink-0 font-mono text-xs text-faint">filters &amp; bulk actions</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
