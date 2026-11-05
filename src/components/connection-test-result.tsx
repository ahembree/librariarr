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
 * chip beside an integration's Test button, naming what answered. `label`
 * replaces the badge's text, for a test that is not a connection (an OIDC
 * discovery fetch). The badge wraps a long answer — an issuer URL, an error —
 * rather than running past the card at 320px.
 */
export function ConnectionTestResult({
  result,
  variant = "banner",
  label,
  className,
}: {
  result: ConnectionTestOutcome;
  variant?: "banner" | "badge";
  label?: string;
  className?: string;
}) {
  if (variant === "badge") {
    const Icon = result.ok ? CheckCircle : AlertCircle;
    return (
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "inline-flex min-w-0 max-w-full items-start gap-1.5 rounded-md border px-2 py-1 text-xs font-medium",
          result.ok
            ? "border-green/30 bg-green-dim text-green"
            : "border-destructive/30 bg-destructive/10 text-destructive",
          className,
        )}
      >
        <Icon className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{label ?? connectionTestLabel(result)}</span>
      </span>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-2 rounded-md p-3 text-sm",
        result.ok ? "bg-green-dim text-green" : "bg-destructive/10 text-destructive",
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
