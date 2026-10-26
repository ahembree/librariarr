import { AlertCircle, CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/** What a connection test answered — a media server's, an integration's. */
export interface ConnectionTestOutcome {
  ok: boolean;
  error?: string | null;
  /** The badge names what answered: "Connected to Radarr v5.2 · 2 servers". */
  appName?: string | null;
  version?: string | null;
  serverCount?: number;
}

/** The badge's text: what answered, or why it failed. */
export function connectionTestLabel(result: ConnectionTestOutcome): string {
  if (!result.ok) return `Failed: ${result.error}`;
  const app = result.appName ? ` to ${result.appName}` : "";
  const version = result.version ? ` v${result.version}` : "";
  const servers =
    result.serverCount !== undefined ? ` · ${result.serverCount} ${result.serverCount === 1 ? "server" : "servers"}` : "";
  return `Connected${app}${version}${servers}`;
}

/**
 * A connection test's answer. `banner` is the full-width box under a server
 * form ("Connection successful" / "Connection failed — <reason>"); `badge` the
 * pill beside an integration's Test button, naming what answered.
 */
export function ConnectionTestResult({
  result,
  variant = "banner",
  className,
}: {
  result: ConnectionTestOutcome;
  variant?: "banner" | "badge";
  className?: string;
}) {
  if (variant === "badge") {
    const Icon = result.ok ? CheckCircle : AlertCircle;
    return (
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
          result.ok
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
            : "border-destructive/30 bg-destructive/10 text-destructive",
          className,
        )}
      >
        <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
        {connectionTestLabel(result)}
      </span>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-2 rounded-md p-3 text-sm",
        result.ok ? "bg-green-500/10 text-green-500" : "bg-destructive/10 text-destructive",
        className,
      )}
    >
      {result.ok ? (
        <>
          <CheckCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          Connection successful
        </>
      ) : (
        <>
          <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          Connection failed{result.error ? ` — ${result.error}` : ""}
        </>
      )}
    </div>
  );
}
