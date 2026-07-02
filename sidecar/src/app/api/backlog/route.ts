/**
 * GET   /api/backlog?workDir=…&status=…  → { workDir, items: BacklogItem[] }
 * POST  /api/backlog  { workDir, title, body?, severity? }  → add (manual UI add)
 * PATCH /api/backlog  { workDir, id, status?, note?, severity?, body? }
 *       → resolve / set status and/or edit fields (detail view)
 *
 * The backlog UI read/write loop (ADR-0044). All verbs delegate to the shared
 * `backlog.ts` store — the same code the `marvin-backlog` MCP tool writes
 * through. Mutating verbs are CSRF-guarded and validate `workDir` against the
 * registered-project set (like `/api/skills/park`), so a drive-by caller can't
 * write `.marvin/backlog/` into an arbitrary path.
 *
 * The manual POST does NOT run the model-write content-class rejection — that
 * guard exists for the MODEL boundary (the MCP tool); a human typing an item in
 * the panel is trusted. Length/count caps still apply (enforced in the store).
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  BACKLOG_SEVERITIES,
  BACKLOG_STATUSES,
  addBacklogItem,
  listBacklog,
  setBacklogStatus,
  updateBacklogItem,
  type BacklogSeverity,
  type BacklogStatus,
} from "@marvin/runtime/backlog";
import { validateProjectCwd } from "@marvin/runtime/projects";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("workDir");
  const v = validateProjectCwd(raw);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });

  const statusParam = req.nextUrl.searchParams.get("status")?.trim();
  const status =
    statusParam && (BACKLOG_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as BacklogStatus)
      : undefined;

  const items = await listBacklog(v.workDir, status ? { status } : undefined);
  return NextResponse.json(
    { workDir: v.workDir, items },
    { headers: { "Cache-Control": "no-store" } },
  );
}

interface AddBody {
  workDir?: string;
  title?: string;
  body?: string;
  severity?: string;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }
  let body: AddBody;
  try {
    body = (await req.json()) as AddBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const v = validateProjectCwd(body.workDir);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });
  if (!body.title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const severity =
    body.severity && (BACKLOG_SEVERITIES as readonly string[]).includes(body.severity)
      ? (body.severity as BacklogSeverity)
      : undefined;

  const res = await addBacklogItem(v.workDir, {
    title: body.title,
    ...(body.body ? { body: body.body } : {}),
    ...(severity ? { severity } : {}),
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, item: res.item, created: res.created });
}

interface PatchBody {
  workDir?: string;
  id?: string;
  status?: string;
  note?: string;
  /** Field edits (backlog detail view) — severity/body REPLACE the
   *  stored value; may be sent with or without a status change. */
  severity?: string;
  body?: string;
}

export async function PATCH(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const v = validateProjectCwd(body.workDir);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });
  if (!body.id?.trim()) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  const hasStatus = body.status !== undefined;
  const hasSeverity = body.severity !== undefined;
  const hasBody = body.body !== undefined;
  if (!hasStatus && !hasSeverity && !hasBody) {
    return NextResponse.json(
      { error: "nothing to change — send status, severity, and/or body" },
      { status: 400 },
    );
  }
  if (hasStatus && !(BACKLOG_STATUSES as readonly string[]).includes(body.status!)) {
    return NextResponse.json(
      { error: `status must be one of ${BACKLOG_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }
  if (hasSeverity && !(BACKLOG_SEVERITIES as readonly string[]).includes(body.severity!)) {
    return NextResponse.json(
      { error: `severity must be one of ${BACKLOG_SEVERITIES.join(", ")}` },
      { status: 400 },
    );
  }
  if (hasBody && body.body!.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }
  // Field edits first, then the status transition (which may append a
  // note to the just-replaced body) — matches how the detail view
  // batches "edit + resolve" into one PATCH.
  if (hasSeverity || hasBody) {
    const res = await updateBacklogItem(v.workDir, body.id, {
      ...(hasSeverity ? { severity: body.severity as BacklogSeverity } : {}),
      ...(hasBody ? { body: body.body } : {}),
    });
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 404 });
    if (!hasStatus) return NextResponse.json({ ok: true, item: res.item });
  }
  const res = await setBacklogStatus(
    v.workDir,
    body.id!,
    body.status as BacklogStatus,
    body.note,
  );
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 404 });
  return NextResponse.json({ ok: true, item: res.item });
}
