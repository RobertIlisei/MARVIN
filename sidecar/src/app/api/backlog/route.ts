/**
 * GET   /api/backlog?workDir=…            → { workDir, items, counts, resolved }
 *         the OPEN items (provisional / open / doing) + the project's counts; the
 *         closed files are not read. `resolved` = { done, dismissed, total } from the
 *         closed index.
 * GET   /api/backlog?workDir=…&status=open|doing|provisional → the same, narrowed
 * GET   /api/backlog?workDir=…&status=resolved|done|dismissed&limit=100&offset=0
 *         → { workDir, items, total, offset, hasMore }: one page of closed items,
 *         newest first (the pane's Resolved tab, loaded when it is opened).
 * POST  /api/backlog  { workDir, title, body?, severity? }  → add (manual UI add)
 * PATCH /api/backlog  { workDir, id, status?, note?, severity?, body?, kind?, blocked?, blockedOn? }
 *       → resolve / set status and/or edit fields (detail view)
 *
 * `severity` is low | medium | high (the pane still receives `med` for medium).
 * A write accepts `severity` or `priority`, and the old `med`.
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

import {
  addBacklogItem,
  BACKLOG_KINDS,
  BACKLOG_SEVERITIES,
  BACKLOG_STATUSES,
  type BacklogItem,
  type BacklogKind,
  type BacklogSeverity,
  type BacklogStatus,
  backlogOverview,
  claimBacklogItem,
  legacySeverity,
  lenientSeverity,
  listResolved,
  setBacklogStatus,
  updateBacklogItem,
} from "@marvin/runtime/backlog";
import { deriveBacklogFromGit } from "@marvin/runtime/backlog-derive";
import { validateProjectCwd } from "@marvin/runtime/projects";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

/** A row as the pane reads it: `severity`, still in its old three-letter spelling (`med`) until the pane reads the normalised value. */
function wire(i: BacklogItem): BacklogItem {
  return { ...i, severity: legacySeverity(i.severity) as BacklogItem["severity"] };
}

/** The client's severity, in either spelling and under either name; undefined when absent, null when present but not a severity. */
function severityOf(body: { priority?: string; severity?: string }): BacklogSeverity | null | undefined {
  const raw = body.severity ?? body.priority;
  return raw === undefined ? undefined : lenientSeverity(raw);
}

const RESOLVED_PAGE = 100;

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("workDir");
  const v = validateProjectCwd(raw);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });

  const statusParam = req.nextUrl.searchParams.get("status")?.trim();

  // The closed items, a page at a time. Nothing else is read.
  if (statusParam === "resolved" || statusParam === "done" || statusParam === "dismissed") {
    const num = (k: string, d: number) => {
      const n = Number(req.nextUrl.searchParams.get(k));
      return Number.isInteger(n) && n >= 0 ? n : d;
    };
    const page = await listResolved(v.workDir, {
      ...(statusParam === "resolved" ? {} : { status: statusParam }),
      limit: num("limit", RESOLVED_PAGE) || RESOLVED_PAGE,
      offset: num("offset", 0),
    });
    return NextResponse.json(
      { workDir: v.workDir, items: page.items.map(wire), total: page.total, offset: page.offset, hasMore: page.hasMore },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const status =
    statusParam && (BACKLOG_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as BacklogStatus)
      : undefined;

  // What git proves fixed is closed — but never on the pane's critical path: the
  // answer below is what is on disk now, and each closure is a write the pane
  // hears about (`backlog.changed`) a moment later.
  void deriveBacklogFromGit(v.workDir);

  // One scan: the open files, and the closed ones counted from the closed index.
  const overview = await backlogOverview(v.workDir);
  const items = status ? overview.open.filter((i) => i.status === status) : overview.open;
  return NextResponse.json(
    {
      workDir: v.workDir,
      items: items.map(wire),
      counts: overview.counts,
      resolved: overview.resolved,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

interface AddBody {
  workDir?: string;
  title?: string;
  body?: string;
  priority?: string;
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
  const severity = severityOf(body);
  if (severity === null) {
    return NextResponse.json({ error: `severity (priority) must be one of ${BACKLOG_SEVERITIES.join(", ")}` }, { status: 400 });
  }

  const res = await addBacklogItem(v.workDir, {
    title: body.title,
    ...(body.body ? { body: body.body } : {}),
    ...(severity ? { severity } : {}),
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  // `related` = live items that look like the same work (ADR-0044 addendum).
  // Advisory: the item is already written. The panel shows it as a hint so a
  // manual add gets the same duplicate warning the MCP path does.
  return NextResponse.json({
    ok: true,
    item: wire(res.item),
    created: res.created,
    related: res.related.map(wire),
  });
}

interface PatchBody {
  workDir?: string;
  id?: string;
  status?: string;
  note?: string;
  /** ADR-0113 — with `status: "doing"`, the tab taking the item. A second
   *  claimant gets 409 with the holder, so the panel can offer Switch. */
  sessionId?: string;
  branch?: string;
  /** Field edits (backlog detail view) — severity/body REPLACE the
   *  stored value; may be sent with or without a status change. `severity`
   *  is the old name the pane still sends (low | med | high). */
  priority?: string;
  severity?: string;
  body?: string;
  /** ADR-0064 — classification. `kind` is what sort of work it is;
   *  `blocked`/`blockedOn` is whether it's waiting on something outside
   *  the repo. Orthogonal to each other and to status. */
  kind?: string;
  blocked?: boolean;
  blockedOn?: string;
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
  const severity = severityOf(body);
  const hasSeverity = severity !== undefined;
  const hasBody = body.body !== undefined;
  const hasKind = body.kind !== undefined;
  const hasBlocked = body.blocked !== undefined;
  const hasBlockedOn = body.blockedOn !== undefined;
  if (!hasStatus && !hasSeverity && !hasBody && !hasKind && !hasBlocked && !hasBlockedOn) {
    return NextResponse.json(
      { error: "nothing to change — send status, severity, body, kind, blocked and/or blockedOn" },
      { status: 400 },
    );
  }
  if (hasStatus && !(BACKLOG_STATUSES as readonly string[]).includes(body.status!)) {
    return NextResponse.json(
      { error: `status must be one of ${BACKLOG_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }
  if (hasSeverity && severity === null) {
    return NextResponse.json(
      { error: `severity (priority) must be one of ${BACKLOG_SEVERITIES.join(", ")}` },
      { status: 400 },
    );
  }
  if (hasKind && !(BACKLOG_KINDS as readonly string[]).includes(body.kind!)) {
    return NextResponse.json(
      { error: `kind must be one of ${BACKLOG_KINDS.join(", ")}` },
      { status: 400 },
    );
  }
  if (hasBody && body.body!.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }
  // Field edits first, then the status transition (which may append a
  // note to the just-replaced body) — matches how the detail view
  // batches "edit + resolve" into one PATCH.
  if (hasSeverity || hasBody || hasKind || hasBlocked || hasBlockedOn) {
    const res = await updateBacklogItem(v.workDir, body.id, {
      ...(severity ? { severity } : {}),
      ...(hasBody ? { body: body.body } : {}),
      ...(hasKind ? { kind: body.kind as BacklogKind } : {}),
      ...(hasBlocked ? { blocked: body.blocked } : {}),
      ...(hasBlockedOn ? { blockedOn: body.blockedOn } : {}),
    });
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 404 });
    if (!hasStatus) return NextResponse.json({ ok: true, item: wire(res.item) });
  }
  if (body.status === "doing" && body.sessionId?.trim()) {
    const claimed = await claimBacklogItem(v.workDir, body.id, {
      sessionId: body.sessionId.trim(),
      ...(body.branch?.trim() ? { branch: body.branch.trim() } : {}),
    });
    if (!claimed.ok) {
      return NextResponse.json(
        { error: claimed.error, ...(claimed.holder ? { code: "held", holder: claimed.holder, holderSessionId: claimed.holderSessionId } : {}) },
        { status: claimed.holder ? 409 : 404 },
      );
    }
    return NextResponse.json({ ok: true, item: wire(claimed.item), alreadyHeld: claimed.alreadyHeld });
  }
  const res = await setBacklogStatus(
    v.workDir,
    body.id!,
    body.status as BacklogStatus,
    body.note,
  );
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 404 });
  return NextResponse.json({ ok: true, item: wire(res.item) });
}
