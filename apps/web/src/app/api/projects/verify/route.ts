import { NextResponse, type NextRequest } from "next/server";

import { verifyWorkDir } from "@marvin/runtime/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/projects/verify?path=… → { ok, absolutePath, exists, isDirectory, readable, error } */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("path");
  if (!raw) {
    return NextResponse.json({ error: "path query is required" }, { status: 400 });
  }
  return NextResponse.json(verifyWorkDir(raw));
}
