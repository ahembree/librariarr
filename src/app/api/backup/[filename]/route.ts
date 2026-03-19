import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getBackupFilePath, deleteBackup } from "@/lib/backup/backup-service";
import fs from "fs/promises";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { filename } = await params;
  const filepath = getBackupFilePath(filename);
  if (!filepath) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  try {
    const data = await fs.readFile(filepath);
    const isGz = filename.endsWith(".gz");
    return new NextResponse(data, {
      headers: {
        "Content-Type": isGz ? "application/gzip" : "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(data.length),
      },
    });
  } catch {
    return NextResponse.json({ error: "Backup not found" }, { status: 404 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { filename } = await params;
  const deleted = await deleteBackup(filename);
  if (!deleted) {
    return NextResponse.json({ error: "Backup not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
