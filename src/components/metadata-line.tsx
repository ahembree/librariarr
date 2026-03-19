"use client";

import { Children, isValidElement } from "react";
import type { ReactNode } from "react";

interface MetadataLineProps {
  children: ReactNode;
}

export function MetadataLine({ children }: MetadataLineProps) {
  const visible = Children.toArray(children).filter(
    (child) => isValidElement(child) && child,
  );

  if (visible.length === 0) return null;

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
