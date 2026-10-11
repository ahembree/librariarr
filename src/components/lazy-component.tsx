"use client";

import { useEffect, useState, type ComponentType } from "react";
import { createModuleLoader } from "@/lib/module-loader";

/**
 * A component whose code loads when it first renders, shown as `Fallback`
 * until then. For code most pages never use (the chart library behind custom
 * dashboard cards and AI evidence), so it stays out of the script a page must
 * load before it is interactive.
 *
 * Deliberately not `next/dynamic`: that is React.lazy, whose fallback is a
 * Suspense fallback, and once React has shown one it holds the real content
 * back for its 300 ms reveal throttle — a chunk that arrives in 20 ms would
 * still cost 300. A state update has no such delay. Once loaded, every later
 * mount renders the component straight away.
 */
export function lazyComponent<P extends object>(
  load: () => Promise<ComponentType<P>>,
  Fallback: ComponentType,
): ComponentType<P> {
  const loader = createModuleLoader(load);

  function LazyComponent(props: P) {
    const [Component, setComponent] = useState<ComponentType<P> | null>(() => loader.get());

    useEffect(() => {
      if (Component) return;
      let active = true;
      loader.load().then(
        (loaded) => {
          if (active) setComponent(() => loaded);
        },
        (error: unknown) => {
          console.error("Failed to load component:", error);
        },
      );
      return () => {
        active = false;
      };
    }, [Component]);

    return Component ? <Component {...props} /> : <Fallback />;
  }

  return LazyComponent;
}
