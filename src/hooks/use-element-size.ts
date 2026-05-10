"use client";

import { useCallback, useRef, useState } from "react";

export function useElementSize<T extends HTMLElement = HTMLDivElement>() {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const refCallback = useCallback((el: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) {
      setSize(null);
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        setSize((prev) =>
          prev && prev.width === width && prev.height === height
            ? prev
            : { width, height },
        );
      }
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  return [refCallback, size] as const;
}
