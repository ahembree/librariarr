import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { access, constants } from "fs/promises";
import nodePath from "node:path";

const ALLOWED_PREFIXES = process.env.PREROLL_ALLOWED_PATHS
  ? process.env.PREROLL_ALLOWED_PATHS.split(",").map((p) => p.trim())
  : ["/media", "/data", "/mnt", "/opt/prerolls"];

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { path } = await req.json();
  if (!path || typeof path !== "string") {
    return NextResponse.json({ error: "Path is required" }, { status: 400 });
  }

  const resolved = nodePath.resolve(path);
  const isAllowed = ALLOWED_PREFIXES.some((prefix) =>
    resolved.startsWith(prefix)
  );
  if (!isAllowed) {
    return NextResponse.json(
      { error: "Path is outside allowed directories" },
      { status: 400 }
    );
  }

  try {
    await access(resolved, constants.R_OK);
    return NextResponse.json({ exists: true });
  } catch {
    return NextResponse.json({ exists: false });
  }
}
