/**
 * Session audit API (ADR-0059).
 *
 * - POST /api/audit  { workDir, projectId, sessionId }
 *     Runs ONE bounded, read-only auditor session over the runtime-assembled
 *     claims-vs-evidence packet and returns the findings report (also persisted
 *     to `<workDir>/.marvin/audits/`). CSRF-guarded + user-initiated: this is
 *     the ONLY trigger in v1, and there is deliberately no MCP tool and no
 *     agents-map entry, so the executor cannot audit itself (ADR-0059 §1).
 * - GET  /api/audit?workDir=…&sessionId=…        → { reports: [path…] }
 * - GET  /api/audit?workDir=…&path=…             → { report } (one report body)
 *
 * The report is returned to the UI for the user. It is NEVER auto-injected
 * into the executor's context — that's the user's call (ADR-0059 §4).
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  listAuditReports,
  readAuditReport,
  runSessionAudit,
} from "@marvin/runtime/session-auditor";
import { validateProjectCwd } from "@marvin/runtime/projects";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** An audit is a bounded model session; give it room but not forever. */
export const maxDuration = 300;

const MAX_BODY_BYTES = 8 * 1024;

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const v = validateProjectCwd(params.get("workDir")?.trim());
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });

  const path = params.get("path")?.trim();
  if (path) {
    const report = readAuditReport(v.workDir, path);
    if (report === null) {
      return NextResponse.json({ error: "report not found" }, { status: 404 });
    }
    return NextResponse.json({ report, path });
  }
  const sessionId = params.get("sessionId")?.trim() || undefined;
  return NextResponse.json({ reports: listAuditReports(v.workDir, sessionId) });
}

interface AuditBody {
  workDir?: string;
  projectId?: string;
  sessionId?: string;
  model?: string;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  const lengthHeader = Number(req.headers.get("content-length") || 0);
  if (lengthHeader > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }

  let body: AuditBody;
  try {
    body = (await req.json()) as AuditBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const v = validateProjectCwd(body.workDir);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });

  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!projectId || !sessionId) {
    return NextResponse.json(
      { error: "`projectId` and `sessionId` are required" },
      { status: 400 },
    );
  }

  const result = await runSessionAudit({
    projectId,
    sessionId,
    cwd: v.workDir,
    ...(typeof body.model === "string" && body.model.trim()
      ? { model: body.model.trim() }
      : {}),
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "audit failed" }, { status: 400 });
  }
  return NextResponse.json(result);
}
