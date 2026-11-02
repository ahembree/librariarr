/**
 * The dashboard's opening reads, answered by its server render on a full page
 * load (`loadDashboardSeed`). Client-safe.
 */
export interface DashboardSeed {
  /** Server time the reads started (epoch ms). */
  at: number;
  /**
   * Each read's JSON body by its URL (`seed-urls.ts`). A read that failed or
   * was still running when the render's budget ran out is absent, and its
   * zone fetches it as before.
   */
  bodies: Record<string, unknown>;
}

/**
 * The server render's clock, for the text it renders from the time: the
 * greeting, the date and every "5m ago". The render that hydrates the page
 * must show what the server showed — a phone in another time zone than the
 * server, or a minute boundary passed between the two renders, otherwise
 * fails hydration and React rebuilds the whole page — and switches to the
 * browser's own clock straight after.
 */
export interface ServerClock {
  /** Server time of the render (epoch ms). */
  at: number;
  /** Hour of day in the server's time zone, for the greeting. */
  hour: number;
  /** "Friday", in the server's time zone and locale. */
  weekday: string;
  /** "October 30", in the server's time zone and locale. */
  monthDay: string;
  /** "2026-10", in the server's time zone: the month the sparklines end at. */
  month: string;
}
