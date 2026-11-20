import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
type LogCategory = "BACKEND" | "API" | "DB";

/**
 * Longest message a log line keeps; the rest is cut with an ellipsis. Far above
 * any line the app writes on purpose — a TRaSH sync names every custom format
 * it applied, a refused execution every id — so only runaway text is cut; a
 * caller quoting text from outside bounds that text itself.
 */
export const MAX_LOG_MESSAGE_LENGTH = 32_000;

/**
 * A log message as one bounded line.
 *
 * Messages interpolate text this app did not write: a media title, a server or
 * instance name, an identity provider's `error` parameter (which arrives on an
 * unauthenticated callback). A line break in one starts what reads as a new,
 * genuine entry on the console — `[2026-…] [Auth] Local login: "admin"` — and
 * an unbounded one fills the log. Control characters become a space; `meta`
 * is printed and stored as structured data and is not touched.
 *
 * Anything that is not a string is turned into one first: the console printed
 * whatever it was handed, and a catch block logging the `message` of something
 * that was not an Error must still log, not throw from inside the logger.
 */
export function logLine(message: unknown): string {
  const text = typeof message === "string" ? message : String(message ?? "");
  // C0 controls, DEL, C1 controls, and the Unicode line/paragraph separators.
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
  return flat.length > MAX_LOG_MESSAGE_LENGTH ? `${flat.slice(0, MAX_LOG_MESSAGE_LENGTH)}…` : flat;
}

async function writeLog(
  level: LogLevel,
  source: string,
  rawMessage: string,
  meta?: Record<string, unknown>,
  category: LogCategory = "BACKEND"
) {
  const message = logLine(rawMessage);
  const prefix = `[${new Date().toISOString()}] [${logLine(source)}]`;
  if (level === "ERROR") console.error(prefix, message, meta ?? "");
  else if (level === "WARN") console.warn(prefix, message, meta ?? "");
  else if (level === "DEBUG") {
    if (process.env.LOG_DEBUG === "true") {
      console.debug(prefix, message, meta ?? "");
    } else {
      return; // Skip DB write when debug logging is disabled
    }
  } else console.log(prefix, message, meta ?? "");

  prisma.logEntry
    .create({
      data: {
        level,
        category,
        source,
        message,
        meta: meta ? (meta as Prisma.InputJsonValue) : undefined,
      },
    })
    .catch(() => {});
}

function makeLogFn(category: LogCategory) {
  return {
    debug: (source: string, message: string, meta?: Record<string, unknown>) =>
      writeLog("DEBUG", source, message, meta, category),
    info: (source: string, message: string, meta?: Record<string, unknown>) =>
      writeLog("INFO", source, message, meta, category),
    warn: (source: string, message: string, meta?: Record<string, unknown>) =>
      writeLog("WARN", source, message, meta, category),
    error: (source: string, message: string, meta?: Record<string, unknown>) =>
      writeLog("ERROR", source, message, meta, category),
  };
}

export const logger = makeLogFn("BACKEND");
export const apiLogger = makeLogFn("API");
export const dbLogger = makeLogFn("DB");
