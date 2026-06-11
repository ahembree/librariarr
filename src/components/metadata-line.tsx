"use client";

import { Children, isValidElement } from "react";
import type { ReactNode, ReactElement } from "react";

interface MetadataItemProps {
  /** Accepted for caller compatibility; the mono dot-joined line no longer
   *  renders per-item icons. */
  icon?: ReactElement;
  children: ReactNode;
}

/** A single metadata entry. Use inside MetadataLine. */
export function MetadataItem({ children }: MetadataItemProps) {
  return <span className="min-w-0 truncate">{children}</span>;
}

interface MetadataLineProps {
  children: ReactNode;
  /** Legacy prop from the icon-row layout; both variants now render the
   *  same compact mono dot-joined line. */
  stacked?: boolean;
}

/** Mono dot-joined metadata line — the data idiom used across cards,
 *  shelves, and detail headers ("2024 · 1h 52m · 4.1 GB"). */
export function MetadataLine({ children }: MetadataLineProps) {
  const visible = Children.toArray(children).filter(
    (child) => isValidElement(child) && child,
  );

  if (visible.length === 0) return null;

  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[10.5px] leading-relaxed text-faint">
      {visible.map((child, i) => (
        <span key={i} className="contents">
          {i > 0 && <span className="text-muted-foreground/40">·</span>}
          {child}
        </span>
      ))}
    </span>
  );
}
