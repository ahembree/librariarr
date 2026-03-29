"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TabNavItem<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  indicator?: React.ReactNode;
}

interface TabNavProps<T extends string> {
  tabs: TabNavItem<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  className?: string;
}

export function TabNav<T extends string>({
  tabs,
  activeTab,
  onTabChange,
  className,
}: TabNavProps<T>) {
  const navRef = useRef<HTMLElement>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    checkScroll();
    el.addEventListener("scroll", checkScroll, { passive: true });
    const ro = new ResizeObserver(checkScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", checkScroll);
      ro.disconnect();
    };
  }, [checkScroll]);

  // Auto-scroll active tab into view
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const activeBtn = el.querySelector<HTMLButtonElement>(
      `[data-tab="${activeTab}"]`
    );
    activeBtn?.scrollIntoView({
      inline: "nearest",
      block: "nearest",
      behavior: "smooth",
    });
  }, [activeTab]);

  return (
    <div className={cn("relative", className)}>
      <nav
        ref={navRef}
        role="tablist"
        className="flex items-center gap-1 border-b overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.value;
          return (
            <button
              key={tab.value}
              role="tab"
              aria-selected={isActive}
              data-tab={tab.value}
              onClick={() => onTabChange(tab.value)}
              className={cn(
                "flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap shrink-0",
                isActive
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
              )}
            >
              {Icon && <Icon className="h-4 w-4" />}
              {tab.label}
              {tab.indicator}
            </button>
          );
        })}
      </nav>
      {canScrollRight && (
        <div className="pointer-events-none absolute right-0 top-0 h-full w-12 bg-linear-to-l from-background to-transparent md:hidden" />
      )}
    </div>
  );
}
