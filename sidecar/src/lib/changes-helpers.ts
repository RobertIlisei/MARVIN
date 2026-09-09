/**
 * Shared request plumbing for the /api/changes/* route family (ADR-0034).
 *
 * Every endpoint takes the same identity triple — cwd (validated against
 * the project registry), marvinSessionId, optional explicit projectId —
 * and resolves it to the checkpoint-store key.
 */

import { slugifyWorkDir } from "@marvin/runtime/projects";
import { validateSessionCwd } from "@marvin/runtime/session-cwd";
import { type NextRequest, NextResponse } from "next/server";

export interface ChangesKey {
  projectId: string;
  marvinSessionId: string;
}

export function resolveChangesKey(
  source: { cwd?: string | null; marvinSessionId?: string | null; projectId?: string | null },
): { error: NextResponse } | { key: ChangesKey; cwd: string } {
  const cwd = source.cwd?.trim();
  const marvinSessionId = source.marvinSessionId?.trim();
  if (!cwd || !marvinSessionId) {
    return {
      error: NextResponse.json(
        { error: "cwd and marvinSessionId are required" },
        { status: 400 },
      ),
    };
  }
  // ADR-0107 — a session worktree is an accepted cwd; the checkpoint key
  // stays the PROJECT (never slugified from the worktree path).
  const check = validateSessionCwd(cwd);
  if (!check.ok) {
    return { error: NextResponse.json({ error: check.error }, { status: 400 }) };
  }
  const projectId = source.projectId?.trim() || slugifyWorkDir(check.workDir);
  return { key: { projectId, marvinSessionId }, cwd: check.cwd };
}

export function keyFromQuery(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  return resolveChangesKey({
    cwd: q.get("cwd"),
    marvinSessionId: q.get("marvinSessionId"),
    projectId: q.get("projectId"),
  });
}
