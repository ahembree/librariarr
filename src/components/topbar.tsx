"use client";

import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { getPageMeta } from "@/lib/nav/page-meta";

/**
 * Glassy top bar shown above page content on desktop. Renders a
 * `Group › Page` breadcrumb derived from the route. Per-page contextual
 * actions are rendered inline within each page's own header (the design
 * keeps page-specific controls in content).
 */
export function Topbar() {
  const pathname = usePathname();
  const { group, title } = getPageMeta(pathname);

  return (
    <header className="glass relative z-10 flex h-16 shrink-0 items-center gap-4 border-b px-7">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2.5 text-[13px]">
        <span className="text-faint">{group}</span>
        <ChevronRight className="h-3.5 w-3.5 text-faint/50" />
        <span className="font-semibold text-foreground">{title}</span>
      </nav>
    </header>
  );
}
