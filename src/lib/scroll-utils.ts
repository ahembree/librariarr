/**
 * Find the active scroll container. Some pages (e.g. lifecycle rule pages)
 * have their own overflow-y scroll container inside <main>, which prevents
 * <main> itself from scrolling. Walk <main>'s descendants (BFS) to find
 * the nearest scrollable element; fall back to <main>.
 */
export function findScrollContainer(): HTMLElement | null {
  const main = document.querySelector<HTMLElement>("main");
  if (!main) return null;

  // BFS through up to 3 levels of children to find the nearest scrollable element.
  // Lifecycle pages use: <main> → <div flex h-full> → <div overflow-y-auto>
  const queue: { el: HTMLElement; depth: number }[] = [];
  for (const child of main.children) {
    if (child instanceof HTMLElement) queue.push({ el: child, depth: 1 });
  }

  while (queue.length > 0) {
    const { el, depth } = queue.shift()!;
    const style = getComputedStyle(el);
    if (style.overflowY === "auto" || style.overflowY === "scroll") {
      return el;
    }
    if (depth < 3) {
      for (const child of el.children) {
        if (child instanceof HTMLElement) queue.push({ el: child, depth: depth + 1 });
      }
    }
  }

  return main;
}
