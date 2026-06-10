/**
 * GET /api/changes/diff?cwd=&marvinSessionId=&path=[&projectId=]
 *
 * Structured hunks for one agent-changed file (ADR-0034):
 * diff(pre-agent baseline → current disk). Hunk indices are positions in
 * THIS recompute and are what /api/changes/accept|reject take — a stale
 * index after a concurrent edit misses safely server-side.
 *
 * Returns `{ path, status, hunks: [{ index, header, lines: [{kind,text}] }] }`.
 */

import { diffFile } from "@marvin/runtime/change-checkpoints";
import { type NextRequest, NextResponse } from "next/server";
import { keyFromQuery } from "@/lib/changes-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const resolved = keyFromQuery(req);
  if ("error" in resolved) return resolved.error;
  const path = req.nextUrl.searchParams.get("path")?.trim();
  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  const diff = diffFile(resolved.key, path);
  if (!diff) {
    return NextResponse.json(
      { error: "no pending change for that path" },
      { status: 404 },
    );
  }
  return NextResponse.json(diff);
}
