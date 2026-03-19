import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const level = searchParams.get("level");
  const source = searchParams.get("source");
  const search = searchParams.get("search");
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
  const limit = Math.min(500, Math.max(1, parseInt(searchParams.get("limit") ?? "100")));

  const where: Prisma.LogEntryWhereInput = {};

  if (level) {
    const levels = level.split(",").filter(Boolean);
    if (levels.length > 0) {
      where.level = { in: levels as ("DEBUG" | "INFO" | "WARN" | "ERROR")[] };
    }
  }

  const category = searchParams.get("category");
  if (category) {
    const categories = category.split(",").filter(Boolean);
    if (categories.length > 0) {
      where.category = { in: categories as ("BACKEND" | "API" | "DB")[] };
    }
  }

  if (source) {
    where.source = source;
  }

  if (search) {
    where.message = { contains: search, mode: "insensitive" };
  }

  const [logs, total] = await Promise.all([
    prisma.logEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.logEntry.count({ where }),
  ]);

  return NextResponse.json({
    logs,
    total,
    page,
    pages: Math.ceil(total / limit),
  });
}
