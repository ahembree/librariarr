import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getArchivePath } from "@/lib/logs/archive";
import fs from "fs/promises";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { filename } = await params;
  const filePath = await getArchivePath(filename);

  if (!filePath) {
    return NextResponse.json({ error: "Archive not found" }, { status: 404 });
  }

  const data = await fs.readFile(filePath);

  return new NextResponse(data, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": data.length.toString(),
    },
  });
}
