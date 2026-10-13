"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Tv, Layers, List, Music, Disc3, ListMusic } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LibraryTab {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const SERIES_TABS: LibraryTab[] = [
  { href: "/library/series", label: "Series", icon: Tv },
  { href: "/library/series/seasons", label: "All Seasons", icon: Layers },
  { href: "/library/series/episodes", label: "All Episodes", icon: List },
];

export const MUSIC_TABS: LibraryTab[] = [
  { href: "/library/music", label: "Artists", icon: Music },
  { href: "/library/music/albums", label: "All Albums", icon: Disc3 },
  { href: "/library/music/tracks", label: "All Tracks", icon: ListMusic },
];

/** Segmented sub-view switcher shared by the series and music library
 *  pages — one definition so the active styling can't drift between the
 *  sibling routes it links. */
export function LibraryTabs({ tabs, active }: { tabs: LibraryTab[]; active: string }) {
  return (
    <nav
      aria-label="Library views"
      className="mb-6 inline-flex h-9 max-w-full items-center gap-1 overflow-x-auto rounded-lg border p-1"
    >
      {tabs.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          // Full prefetch — see the sidebar's nav links.
          prefetch
          aria-current={active === href ? "page" : undefined}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] font-medium whitespace-nowrap transition-colors sm:px-3",
            active === href
              ? "bg-brand-dim text-brand-bright"
              : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
          )}
        >
          {/* The icons go on the narrowest phones, where all three labels
              would not otherwise fit beside one another. */}
          <Icon className="hidden h-3.5 w-3.5 min-[360px]:block" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
