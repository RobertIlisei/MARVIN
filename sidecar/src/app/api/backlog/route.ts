/**
 * GET   /api/backlog?workDir=…&status=…  → { workDir, items: BacklogItem[] }
 * POST  /api/backlog  { workDir, title, body?, severity? }  → add (manual UI add)
 * PATCH /api/backlog  { workDir, id, status, note? }         → resolve / set status
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
  if (!body.status || !(BACKLOG_STATUSES as readonly string[]).includes(body.status)) {
    return NextResponse.json(
      { error: `status must be one of ${BACKLOG_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }
  const res = await setBacklogStatus(
    v.workDir,
    body.id,
    body.status as BacklogStatus,
    body.note,
  );
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 404 });
  return NextResponse.json({ ok: true, item: res.item });
}
