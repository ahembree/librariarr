"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Recycle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytesNum, formatUntil } from "@/lib/format";
import type { ScheduleInfo } from "@/components/dashboard/types";

interface PipelineData {
  ruleTotal: number;
  ruleEnabled: number;
  matchCount: number;
  matchRuleSets: number;
  pendingCount: number;
  pendingBytes: number;
  reclaimedBytes: number;
  reclaimedActions: number;
}

function Stage({
  href,
  label,
  value,
  sub,
  arrow = false,
}: {
  href: string;
  label: string;
  value: string;
  sub: string;
  arrow?: boolean;
}) {
  return (
    <Link
      href={href}
      className="group relative flex flex-col gap-1 rounded-[10px] px-4 py-3 transition-colors hover:bg-surface-2/50"
    >
      <span className="eyebrow">{label}</span>
      <span className="font-display text-2xl leading-none font-semibold tracking-[-0.02em] tabular-nums">
        {value}
      </span>
      <span className="truncate font-mono text-[11px] text-faint">{sub}</span>
      {arrow && (
        <ChevronRight className="absolute top-1/2 -right-[15px] hidden h-4 w-4 -translate-y-1/2 text-faint lg:block" />
      )}
    </Link>
  );
}

/**
 * The lifecycle funnel at a glance: enabled rules → current matches →
 * scheduled actions (with the next execution countdown) → space reclaimed.
 * Each stage deep-links to its lifecycle page. Shows a create-your-first-rule
 * CTA when no rule sets exist yet.
 */
export function LifecyclePipeline({ scheduleInfo }: { scheduleInfo: ScheduleInfo | null }) {
  const [data, setData] = useState<PipelineData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [rulesRes, matchesRes, statsRes] = await Promise.allSettled([
        fetch("/api/lifecycle/rules").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/lifecycle/rules/matches").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/lifecycle/stats").then((r) => (r.ok ? r.json() : null)),
      ]);
      if (cancelled) return;

      const ruleSets: { enabled: boolean }[] =
        rulesRes.status === "fulfilled" ? (rulesRes.value?.ruleSets ?? []) : [];
      const ruleMatches: { count: number }[] =
        matchesRes.status === "fulfilled" ? (matchesRes.value?.ruleMatches ?? []) : [];
      const stats = statsRes.status === "fulfilled" ? statsRes.value : null;

      setData({
        ruleTotal: ruleSets.length,
        ruleEnabled: ruleSets.filter((r) => r.enabled).length,
        matchCount: ruleMatches.reduce((a, g) => a + (g.count ?? 0), 0),
        matchRuleSets: ruleMatches.filter((g) => (g.count ?? 0) > 0).length,
        pendingCount: stats?.pendingCount ?? 0,
        pendingBytes: Number(stats?.pendingBytes ?? 0),
        reclaimedBytes: Number(stats?.totalBytesDeleted ?? 0),
        reclaimedActions: stats?.actionCount ?? 0,
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <Skeleton className="h-[92px] w-full rounded-[14px]" />;
  }

  if (!data || data.ruleTotal === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-[14px] border bg-card px-5 py-4 shadow-[var(--shadow-card)] sm:flex-row sm:items-center">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] border border-border bg-surface-2 text-muted-foreground">
          <Recycle className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">No lifecycle rules yet</p>
          <p className="text-xs text-muted-foreground">
            Rules find stale media automatically and schedule cleanup actions through Sonarr,
            Radarr, and Lidarr.
          </p>
        </div>
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link href="/lifecycle/rules">Create a rule set</Link>
        </Button>
      </div>
    );
  }

  const nextExecution = scheduleInfo?.execution.nextRun ?? null;

  return (
    <div className="rounded-[14px] border bg-card p-2 shadow-[var(--shadow-card)]">
      <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
        <Stage
          href="/lifecycle/rules"
          label="Rule sets"
          value={data.ruleEnabled.toLocaleString()}
          sub={`${data.ruleTotal.toLocaleString()} total · ${data.ruleEnabled.toLocaleString()} enabled`}
          arrow
        />
        <Stage
          href="/lifecycle/matches"
          label="Matches"
          value={data.matchCount.toLocaleString()}
          sub={
            data.matchCount > 0
              ? `across ${data.matchRuleSets.toLocaleString()} rule set${data.matchRuleSets === 1 ? "" : "s"}`
              : "nothing matched yet"
          }
          arrow
        />
        <Stage
          href="/lifecycle/pending"
          label="Pending actions"
          value={data.pendingCount.toLocaleString()}
          sub={
            data.pendingCount > 0
              ? `${formatBytesNum(data.pendingBytes)} · runs ${formatUntil(nextExecution)}`
              : `next run ${formatUntil(nextExecution)}`
          }
          arrow
        />
        <Stage
          href="/lifecycle/pending"
          label="Reclaimed"
          value={formatBytesNum(data.reclaimedBytes)}
          sub={`${data.reclaimedActions.toLocaleString()} completed action${data.reclaimedActions === 1 ? "" : "s"}`}
        />
      </div>
    </div>
  );
}
