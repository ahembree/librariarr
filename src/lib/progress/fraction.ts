/**
 * Helpers for composing determinate 0..1 progress fractions across the nested,
 * sometimes-concurrent work that the *arr/Seerr metadata fetchers perform.
 *
 * A "reporter" is simply `(fraction: number) => void`. These helpers let a
 * parent reporter be split across concurrent children (averaged) or scaled into
 * a sub-range, so a fetcher can map its internal stages (fetch lists → score →
 * map) onto a single smooth bar without each layer knowing the whole picture.
 */

export type FractionReporter = (fraction: number) => void;

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Scale a child's 0..1 fraction into the `[lo, hi]` slice of a parent reporter.
 * Returns `undefined` when there's no parent (so callers can cheaply no-op).
 */
export function subProgress(
  report: FractionReporter | undefined,
  lo: number,
  hi: number,
): FractionReporter | undefined {
  if (!report) return undefined;
  return (f) => report(lo + (hi - lo) * clamp01(f));
}

/**
 * Split a parent reporter into `n` concurrent child reporters whose mean is
 * forwarded to the parent. Each child advances independently (children that
 * never report stay at 0), so the combined value is monotonic as long as each
 * child is. Returns an array of `n` reporters.
 */
export function splitProgress(
  report: FractionReporter | undefined,
  n: number,
): FractionReporter[] {
  if (n <= 0) return [];
  const fractions = new Array<number>(n).fill(0);
  return fractions.map((_, i) => (f: number) => {
    fractions[i] = clamp01(f);
    if (report) {
      let sum = 0;
      for (const v of fractions) sum += v;
      report(sum / n);
    }
  });
}
