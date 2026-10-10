/**
 * Geometry for a drawn horizontal scrollbar (DataTable's sticky bar). Pure and
 * client-safe so it can be unit-tested.
 */

/** Narrowest the thumb gets, so it stays grabbable on a very wide table. */
export const MIN_THUMB_WIDTH = 40;

/** Thumb width and left offset (px) within a track of `trackWidth`. */
export function horizontalThumb(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
  trackWidth: number,
): { width: number; left: number } {
  if (scrollWidth <= clientWidth || trackWidth <= 0) return { width: Math.max(trackWidth, 0), left: 0 };
  const width = Math.min(trackWidth, Math.max(MIN_THUMB_WIDTH, (clientWidth / scrollWidth) * trackWidth));
  const maxScroll = scrollWidth - clientWidth;
  const fraction = Math.min(1, Math.max(0, scrollLeft / maxScroll));
  return { width, left: fraction * (trackWidth - width) };
}

/** How far the content scrolls for each pixel the thumb is dragged. */
export function scrollPerThumbPixel(
  scrollWidth: number,
  clientWidth: number,
  trackWidth: number,
  thumbWidth: number,
): number {
  const travel = trackWidth - thumbWidth;
  if (travel <= 0) return 0;
  return (scrollWidth - clientWidth) / travel;
}
