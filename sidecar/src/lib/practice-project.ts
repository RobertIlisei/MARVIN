import type { NextRequest } from "next/server";
import { getProject } from "@marvin/runtime/projects";

/** The practice routes key on a REGISTERED project id (ADR-0105) — never a
 *  free-form path, so a drive-by caller cannot make the runner read an
 *  arbitrary directory of JSONL. */
export function projectIdFrom(req: NextRequest, body?: { projectId?: unknown }): string | null {
  const raw =
    (typeof body?.projectId === "string" ? body.projectId : null) ?? req.nextUrl.searchParams.get("projectId");
  const id = raw?.trim();
  if (!id) return null;
  return getProject(id) ? id : null;
}
