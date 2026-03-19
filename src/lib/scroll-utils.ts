/**
 * Find the active scroll container. Some pages (e.g. lifecycle rule pages)
 * have their own overflow-y scroll container inside <main>, which prevents
 * <main> itself from scrolling. Walk <main>'s immediate children to find
 * the deepest directly-nested scrollable element; fall back to <main>.
 */
export function findScrollContainer(): HTMLElement | null {
  const main = document.querySelector<HTMLElement>("main");
  if (!main) return null;

  // Check if a direct child (or its first child) is the actual scroll container.
  // Lifecycle pages use: <main> → <div flex h-full> → <div overflow-y-auto>
  let el: HTMLElement | null = main;
  for (let depth = 0; depth < 3; depth++) {
    const child = el.firstElementChild as HTMLElement | null;
    if (!child) break;
    const style = getComputedStyle(child);
    if (style.overflowY === "auto" || style.overflowY === "scroll") {
      return child;
    }
    el = child;
  }

  return main;
}
