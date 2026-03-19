import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
type LogCategory = "BACKEND" | "API" | "DB";

async function writeLog(
  level: LogLevel,
  source: string,
  message: string,
  meta?: Record<string, unknown>,
  category: LogCategory = "BACKEND"
) {
  const prefix = `[${new Date().toISOString()}] [${source}]`;
  if (level === "ERROR") console.error(prefix, message, meta ?? "");
  else if (level === "WARN") console.warn(prefix, message, meta ?? "");
  else if (level === "DEBUG") {
    if (process.env.LOG_DEBUG === "true") {
      console.debug(prefix, message, meta ?? "");
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
