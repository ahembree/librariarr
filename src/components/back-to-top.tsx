"use client";

import { useState, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { findScrollContainer } from "@/lib/scroll-utils";

const SHOW_THRESHOLD = 300;

export function BackToTop() {
  const [visible, setVisible] = useState(false);
  const pathname = usePathname();

  const scrollToTop = useCallback(() => {
    const container = findScrollContainer();
    if (container) container.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    // Re-detect scroll container on route changes (layout may differ)
    const container = findScrollContainer();
    if (!container) return;

    const onScroll = () => {
      setVisible(container.scrollTop > SHOW_THRESHOLD);
    };

    // Reset visibility for the new page
    onScroll();

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [pathname]);

  return (
    <button
      onClick={scrollToTop}
      aria-label="Back to top"
      className={cn(
        "fixed bottom-16 right-6 z-30 flex h-10 w-10 items-center justify-center rounded-full",
        "bg-primary text-primary-foreground shadow-lg",
        "transition-all duration-200",
        "hover:bg-primary/90 hover:scale-110",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-4 opacity-0",
      )}
    >
      <ArrowUp className="h-5 w-5" />
    </button>
  );
}
