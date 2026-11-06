/**
 * Shared fallback palette for chart series without chip-color mappings: the
 * chart tokens in globals.css, in the order the dashboard has always handed
 * out hues (blue, purple, green, amber, red, cyan, pink, orange, teal, indigo,
 * lime, rose, sky, violet, fuchsia). CSS variables, so a value can go
 * straight into an SVG fill/stroke, an inline style or a color-mix().
 */
export const AUTO_HEX = [
  "var(--chart-1)",
  "var(--chart-6)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-7)",
  "var(--chart-8)",
  "var(--chart-9)",
  "var(--chart-10)",
  "var(--chart-11)",
  "var(--chart-12)",
  "var(--chart-13)",
  "var(--chart-5)",
  "var(--chart-14)",
  "var(--chart-4)",
  "var(--chart-15)",
];

/** Color for aggregated "Other" buckets and hidden/disabled series. */
export const OTHER_HEX = "var(--chart-other)";
