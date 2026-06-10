/**
 * GET /api/changes?cwd=&marvinSessionId=[&projectId=]
 *
 * The agent-edit changed set for a session (ADR-0034) — Cursor-style
 * change review. Lists files whose CURRENT disk content differs from
 * their pre-first-agent-touch baseline, with add/del counts and turn
 * attribution. Distinct from `/api/git/status`: this is "what did the
 * agent change since I last accepted", not "what's dirty vs HEAD".
 *
 * Returns `{ files: ChangedFile[] }`.
 */

import { listChanges } from "@marvin/runtime/change-checkpoints";
import { type NextRequest, NextResponse } from "next/server";
import { keyFromQuery } from "@/lib/changes-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const resolved = keyFromQuery(req);
  if ("error" in resolved) return resolved.error;
  return NextResponse.json({ files: listChanges(resolved.key) });
}
