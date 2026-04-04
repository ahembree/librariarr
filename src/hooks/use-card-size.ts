"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

export type CardSize = "small" | "medium" | "large";

const CARD_MIN_WIDTHS: Record<CardSize, number> = {
  small: 100,
  medium: 125,
  large: 175,
};

// On mobile (<768px), shift sizes down so S fits an extra column
const MOBILE_CARD_MIN_WIDTHS: Record<CardSize, number> = {
  small: 80,
  medium: 100,
  large: 125,
};

const LANDSCAPE_MIN_WIDTHS: Record<CardSize, number> = {
  small: 140,
  medium: 200,
  large: 260,
};

const MOBILE_LANDSCAPE_MIN_WIDTHS: Record<CardSize, number> = {
  small: 110,
  medium: 140,
  large: 200,
};

const GAP = 16;
const STORAGE_KEY = "library-card-size";

// Sidebar is ~256px on xl+, page padding ~24-48px, alphabet filter ~32px
const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280 };

function estimateContentWidth(screenWidth: number): number {
  if (screenWidth >= BREAKPOINTS.xl) return screenWidth - 300;
  if (screenWidth >= BREAKPOINTS.lg) return screenWidth - 100;
  if (screenWidth >= BREAKPOINTS.md) return screenWidth - 80;
  return screenWidth - 48;
}

// --- Card size external store ---
let sizeListeners: Array<() => void> = [];

function subscribeSize(listener: () => void) {
  sizeListeners.push(listener);
  return () => {
    sizeListeners = sizeListeners.filter((l) => l !== listener);
  };
}

function getSizeSnapshot(): CardSize {
  const stored = localStorage.getItem(STORAGE_KEY) as CardSize | null;
  return stored && stored in CARD_MIN_WIDTHS ? stored : "medium";
}

function getSizeServerSnapshot(): CardSize {
  return "medium";
}

// --- Screen width external store ---
let widthListeners: Array<() => void> = [];

function notifyWidthListeners() {
  for (const l of widthListeners) l();
}

function subscribeWidth(listener: () => void) {
  widthListeners.push(listener);
  if (widthListeners.length === 1) {
    window.addEventListener("resize", notifyWidthListeners);
  }
  return () => {
    widthListeners = widthListeners.filter((l) => l !== listener);
    if (widthListeners.length === 0) {
      window.removeEventListener("resize", notifyWidthListeners);
    }
  };
}

function getWidthSnapshot(): number {
  return window.innerWidth;
}

function getWidthServerSnapshot(): number {
  return 1200;
}

/**
 * Hook for managing card size with 3 presets (S/M/L).
 * Computes column count from the card width and estimated content area.
 * Returns a CSS gridStyle for non-virtualized grids (auto-fill).
 *
 * Uses useSyncExternalStore for both card size and screen width to avoid
 * hydration mismatches (server snapshot defaults to "medium" / 1200px).
 */
export function useCardSize() {
  const size = useSyncExternalStore(
    subscribeSize,
    getSizeSnapshot,
    getSizeServerSnapshot,
  );

  const screenWidth = useSyncExternalStore(
    subscribeWidth,
    getWidthSnapshot,
    getWidthServerSnapshot,
  );

  const setSize = useCallback((s: CardSize) => {
    localStorage.setItem(STORAGE_KEY, s);
    for (const l of sizeListeners) l();
  }, []);

  const isMobile = screenWidth < BREAKPOINTS.md;
  const cardWidth = isMobile ? MOBILE_CARD_MIN_WIDTHS[size] : CARD_MIN_WIDTHS[size];

  const columns = useMemo(() => {
    const contentWidth = estimateContentWidth(screenWidth);
    return Math.max(2, Math.floor((contentWidth + GAP) / (cardWidth + GAP)));
  }, [screenWidth, cardWidth]);

  const landscapeWidth = isMobile ? MOBILE_LANDSCAPE_MIN_WIDTHS[size] : LANDSCAPE_MIN_WIDTHS[size];

  // For non-virtualized grids: auto-fill with card min width
  const gridStyle = useMemo(
    () => ({
      display: "grid" as const,
      gap: "1rem",
      gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))`,
    }),
    [cardWidth],
  );

  const landscapeGridStyle = useMemo(
    () => ({
      display: "grid" as const,
      gap: "1rem",
      gridTemplateColumns: `repeat(auto-fill, minmax(${landscapeWidth}px, 1fr))`,
    }),
    [landscapeWidth],
  );

  return { size, setSize, columns, gridStyle, landscapeGridStyle, cardWidth };
}

export { CARD_MIN_WIDTHS, MOBILE_CARD_MIN_WIDTHS, BREAKPOINTS, estimateContentWidth };
