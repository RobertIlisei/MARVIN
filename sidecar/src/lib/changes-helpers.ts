/**
 * Shared request plumbing for the /api/changes/* route family (ADR-0034).
 *
 * Every endpoint takes the same identity triple — cwd (validated against
 * the project registry), marvinSessionId, optional explicit projectId —
 * and resolves it to the checkpoint-store key.
 */

import { slugifyWorkDir, validateProjectCwd } from "@marvin/runtime/projects";
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
  const check = validateProjectCwd(cwd);
  if (!check.ok) {
    return { error: NextResponse.json({ error: check.error }, { status: 400 }) };
  }
  const projectId = source.projectId?.trim() || slugifyWorkDir(cwd);
  return { key: { projectId, marvinSessionId }, cwd };
}

export function keyFromQuery(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  return resolveChangesKey({
    cwd: q.get("cwd"),
    marvinSessionId: q.get("marvinSessionId"),
    projectId: q.get("projectId"),
  });
}
