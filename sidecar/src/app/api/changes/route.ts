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

import { listChanges, reconcileCommitted } from "@marvin/runtime/change-checkpoints";
import { type NextRequest, NextResponse } from "next/server";
import { keyFromQuery } from "@/lib/changes-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const resolved = keyFromQuery(req);
  if ("error" in resolved) return resolved.error;
  // ADR-0034 follow-up: a committed agent change is an accepted one — drop
  // reviewed files now clean vs HEAD before listing, so committing clears
  // the strip the way it clears VS Code's Source Control list. HEAD-gated,
  // so a quiescent poll is just one `git rev-parse`.
  reconcileCommitted(resolved.key, resolved.cwd);
  return NextResponse.json({ files: listChanges(resolved.key) });
}
