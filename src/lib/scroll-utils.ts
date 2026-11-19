/** Slack, in px, when comparing a box's edges with <main>'s (subpixel layout). */
const EDGE_TOLERANCE = 2;

/**
 * Find the active scroll container. Some pages (e.g. lifecycle rule pages)
 * have their own overflow-y scroll container inside <main>, which prevents
 * <main> itself from scrolling. Walk <main>'s descendants (BFS, up to 3
 * levels) for a box that fills <main>'s content area and scrolls vertically;
 * fall back to <main>.
 *
 * Filling <main> is what tells the page's scroll box from a box that only
 * scrolls sideways: a table's `overflow-x-auto` wrapper or a tab strip
 * computes `overflow-y: auto` too (CSS turns a `visible` axis into `auto`
 * beside a scrolling one), but it grows with its content instead of being
 * bounded by <main>. Taking those for the page's scroller sent every reader
 * (scroll restoration, Back to top, the reset on navigation) to an element
 * that never scrolls. Where two boxes fill <main> (the pinned rule rail beside
 * the editor), the one with the most to scroll is the page.
 */
export function findScrollContainer(): HTMLElement | null {
  // A server render has no page to scroll.
  if (typeof document === "undefined") return null;
  const main = document.querySelector<HTMLElement>("main");
  if (!main) return null;

  const mainStyle = getComputedStyle(main);
  const padTop = parseFloat(mainStyle.paddingTop) || 0;
  const padBottom = parseFloat(mainStyle.paddingBottom) || 0;
  const contentTop = main.getBoundingClientRect().top + padTop;
  const contentHeight = main.clientHeight - padTop - padBottom;

  const fillsMain = (el: HTMLElement): boolean => {
    const style = getComputedStyle(el);
    if (style.overflowY !== "auto" && style.overflowY !== "scroll") return false;
    const rect = el.getBoundingClientRect();
    return (
      rect.height > 0 &&
      Math.abs(rect.top - contentTop) <= EDGE_TOLERANCE &&
      Math.abs(rect.height - contentHeight) <= EDGE_TOLERANCE
    );
  };

  let best: HTMLElement | null = null;
  const queue: { el: HTMLElement; depth: number }[] = [];
  for (const child of main.children) {
    if (child instanceof HTMLElement) queue.push({ el: child, depth: 1 });
  }

  while (queue.length > 0) {
    const { el, depth } = queue.shift()!;
    if (fillsMain(el)) {
      if (!best || el.scrollHeight - el.clientHeight > best.scrollHeight - best.clientHeight) best = el;
      // The page's scroll box holds the page: nothing inside it is the page's.
      continue;
    }
    if (depth < 3) {
      for (const child of el.children) {
        if (child instanceof HTMLElement) queue.push({ el: child, depth: depth + 1 });
      }
    }
  }

  return best ?? main;
}
