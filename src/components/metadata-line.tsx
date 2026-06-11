"use client";

import { Children, isValidElement } from "react";
import type { ReactNode, ReactElement } from "react";

interface MetadataItemProps {
  icon: ReactElement;
  children: ReactNode;
}

/** A single metadata entry with an icon. Use inside MetadataLine. */
export function MetadataItem({ icon, children }: MetadataItemProps) {
  return (
    <span className="inline-flex items-center gap-1 min-w-0">
      <span className="shrink-0 opacity-60 [&_svg]:h-3 [&_svg]:w-3">{icon}</span>
      <span className="truncate">{children}</span>
    </span>
  );
}

interface MetadataLineProps {
  children: ReactNode;
  /** Render items stacked vertically instead of inline with dots */
  stacked?: boolean;
}

export function MetadataLine({ children, stacked }: MetadataLineProps) {
  const visible = Children.toArray(children).filter(
    (child) => isValidElement(child) && child,
  );

  if (visible.length === 0) return null;

  if (stacked) {
    return (
      <span className="flex flex-col gap-0.5">
        {visible.map((child, i) => (
          <span key={i}>{child}</span>
        ))}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5 flex-wrap">
      {visible.map((child, i) => (
        <span key={i} className="contents">
          {i > 0 && <span>&middot;</span>}
          {child}
        </span>
      ))}
    </span>
  );
}
