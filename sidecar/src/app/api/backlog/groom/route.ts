/**
 * GET /api/backlog/groom?workDir=…&staleDays=…&maxFindings=…
 *   → { workDir, scanned, live, truncated, findings: [...] }
 *
 * The read side of the backlog groomer (ADR-0063), for the macOS Backlog
 * panel's "Review" button. Same analysis the `backlog_groom` MCP tool runs —
 * `groomBacklog` is the single implementation, so the panel and the model can
 * never disagree about what's wrong with the backlog.
 *
 * READ-ONLY, deliberately and structurally: there is no POST/PATCH here and no
 * write path in `backlog-groom.ts` to reach. Every finding is a heuristic, so
 * acting on one is the USER's call — the panel renders findings next to the
 * items and lets them resolve/edit through the existing mutating routes.
 *
 * A GET read like the sibling list route, so no CSRF guard; `workDir` is still
 * validated against the registered-project set so a drive-by caller can't
 * enumerate an arbitrary directory.
 */

import { type NextRequest, NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

import { groomBacklog } from "@marvin/runtime/backlog-groom";
import { listBacklog } from "@marvin/runtime/backlog";
import { validateProjectCwd } from "@marvin/runtime/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Parse a positive-int query param, ignoring junk rather than 400-ing on it. */
function positiveInt(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const v = validateProjectCwd(params.get("workDir"));
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });

  const items = await listBacklog(v.workDir);
  const staleDays = positiveInt(params.get("staleDays"));
  const maxFindings = positiveInt(params.get("maxFindings"));

  const report = groomBacklog(items, {
    now: new Date(),
    ...(staleDays ? { staleDays } : {}),
    ...(maxFindings ? { maxFindings } : {}),
    // Resolved against the project root only. A path that escapes the project
    // is reported as PRESENT: we can't verify it, and calling an unverifiable
    // path "missing" would be a false accusation about the user's own work.
    fileExists: (ref) => {
      const abs = resolve(v.workDir, ref);
      if (!abs.startsWith(resolve(v.workDir) + sep)) return true;
      return existsSync(abs);
    },
  });

  return NextResponse.json({
    workDir: v.workDir,
    scanned: report.scanned,
    live: report.live,
    truncated: report.truncated,
    // Flattened for the client: the panel keys findings by item id, and
    // shipping whole BacklogItem copies would duplicate what it already has.
    findings: report.findings.map((f) => ({
      kind: f.kind,
      id: f.item.id,
      title: f.item.title,
      severity: f.item.severity,
      status: f.item.status,
      relatedIds: f.related.map((r) => r.id),
      detail: f.detail,
      suggestion: f.suggestion,
    })),
  });
}
