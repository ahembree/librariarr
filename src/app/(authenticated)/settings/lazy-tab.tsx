"use client";

import { useState, type ComponentType } from "react";
import { lazyComponent } from "@/components/lazy-component";
import { SettingsPanelSkeleton } from "@/components/skeletons";
import { createModuleLoader } from "@/lib/module-loader";

export interface LazySettingsTab<P extends object> {
  /** The tab: its component, once its code is in. */
  View: ComponentType<P>;
  /** Load the tab's code (once); the page waits for it with the tab's data. */
  load: () => Promise<unknown>;
}

/**
 * A Settings tab whose code loads on demand, so the page's own script carries
 * none of the eight tabs it does not show yet.
 *
 * The page loads a tab's code with its data (`load` sits in the tab's loader
 * list) and renders the tab only once both are in, so the component is
 * normally there by its first render: `View` renders it straight away.
 * `lazyComponent` alone would show its fallback for a frame first, since it
 * learns that the code is loaded in an effect. If the code failed to load,
 * `View` is `lazyComponent`'s skeleton-and-retry instead. Which of the two a
 * mount uses is decided once, as it mounts: switching from one to the other
 * would remount the tab and drop what its forms hold.
 */
export function lazySettingsTab<P extends object>(load: () => Promise<ComponentType<P>>): LazySettingsTab<P> {
  const code = createModuleLoader(load);
  const Retrying = lazyComponent(code.load, SettingsPanelSkeleton);

  function View(props: P) {
    const [Component] = useState<ComponentType<P>>(() => code.get() ?? Retrying);
    return <Component {...props} />;
  }

  return { View, load: code.load };
}
