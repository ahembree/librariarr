"use client";

import { type ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Drop-in `<img>` replacement that fades in when the image loads.
 * Uses DOM class manipulation (no React state) to avoid re-renders
 * in virtualized grids with many images.
 */
export function FadeImage({ className, onLoad, onError, ...props }: ComponentProps<"img">) {
  return (
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text -- thin wrapper; alt passed via props
    <img
      decoding="async"
      fetchPriority="low"
      {...props}
      className={cn("opacity-0 transition-opacity duration-300", className)}
      onLoad={(e) => {
        e.currentTarget.classList.remove("opacity-0");
        onLoad?.(e);
      }}
      onError={(e) => {
        e.currentTarget.classList.remove("opacity-0");
        onError?.(e);
      }}
    />
  );
}
