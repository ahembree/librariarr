"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Library,
  Recycle,
  Settings,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface Tab {
  name: string;
  href: string;
  icon: LucideIcon;
  /** Pathname prefixes that mark this tab active; defaults to [href]. */
  match?: string[];
}

const TABS: Tab[] = [
  { name: "Home", href: "/", icon: LayoutDashboard, match: ["/"] },
  { name: "Library", href: "/library/movies", icon: Library, match: ["/library"] },
  { name: "Lifecycle", href: "/lifecycle/rules", icon: Recycle, match: ["/lifecycle"] },
  { name: "Tools", href: "/tools/streams", icon: Wrench, match: ["/tools"] },
  { name: "Settings", href: "/settings", icon: Settings, match: ["/settings", "/system"] },
];

function isActive(tab: Tab, pathname: string): boolean {
  return (tab.match ?? [tab.href]).some((prefix) =>
    prefix === "/" ? pathname === "/" : pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

/**
 * Fixed bottom tab bar — the primary navigation on small screens, giving
 * the installed PWA a native-app feel. The full nav (sub-pages, logs,
 * query) stays available in the drawer behind the header menu button.
 * Hidden at md+ where the sidebar takes over.
 */
export function MobileTabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="glass pb-safe fixed inset-x-0 bottom-0 z-40 border-t md:hidden"
    >
      <div className="grid h-[var(--tabbar-height)] grid-cols-5">
        {TABS.map((tab) => {
          const active = isActive(tab, pathname);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.name}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-col items-center justify-center gap-1 transition-colors",
                active ? "text-brand-bright" : "text-faint active:text-foreground",
              )}
            >
              <span
                className={cn(
                  "flex h-7 w-12 items-center justify-center rounded-full transition-colors",
                  active && "bg-brand-dim",
                )}
              >
                <Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 2} />
              </span>
              <span className="text-[10.5px] font-medium leading-none">{tab.name}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
