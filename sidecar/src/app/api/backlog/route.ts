/**
 * GET   /api/backlog?workDir=…            → { workDir, items, counts, resolved }
 *         the OPEN items (provisional / open / doing) + the project's counts; the
 *         archive is not read. `resolved` = { done, dismissed, total } from the
 *         archive's summary file.
 * GET   /api/backlog?workDir=…&status=open|doing|provisional → the same, narrowed
 * GET   /api/backlog?workDir=…&status=resolved|done|dismissed&limit=100&offset=0
 *         → { workDir, items, total, offset, hasMore }: one page of the archive,
 *         newest first (the pane's Resolved tab, loaded when it is opened).
 * POST  /api/backlog  { workDir, title, body?, priority? }  → add (manual UI add)
 * PATCH /api/backlog  { workDir, id, status?, note?, priority?, body?, kind?, blocked?, blockedOn? }
 *       → resolve / set status and/or edit fields (detail view)
 *
 * Rows carry `priority` (low | medium | high) and, for the macOS pane that
 * still reads it, `severity` (low | med | high). A write accepts either name.
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
  archiveCounts,
  BACKLOG_KINDS,
  BACKLOG_PRIORITIES,
  BACKLOG_STATUSES,
  type BacklogItem,
  type BacklogKind,
  type BacklogPriority,
  type BacklogStatus,
  claimBacklogItem,
  legacySeverity,
  lenientPriority,
  listBacklog,
  listResolved,
  setBacklogStatus,
  updateBacklogItem,
} from "@marvin/runtime/backlog";
import { deriveBacklogFromGit } from "@marvin/runtime/backlog-derive";
import { getBacklogLive } from "@marvin/runtime/backlog-live";
import { validateProjectCwd } from "@marvin/runtime/projects";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

/** A row as the pane reads it: `priority`, plus the old three-letter `severity` it still decodes. */
function wire(i: BacklogItem): BacklogItem & { severity: string } {
  return { ...i, severity: legacySeverity(i.priority) };
}

/** The client's priority, in either spelling and either field name; undefined when absent, null when present but not a priority. */
function priorityOf(body: { priority?: string; severity?: string }): BacklogPriority | null | undefined {
  const raw = body.priority ?? body.severity;
  return raw === undefined ? undefined : lenientPriority(raw);
}

const RESOLVED_PAGE = 100;

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("workDir");
  const v = validateProjectCwd(raw);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });

  const statusParam = req.nextUrl.searchParams.get("status")?.trim();

  // The archive, a page at a time. Nothing else is read.
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

  const [items, resolved, snap] = await Promise.all([
    listBacklog(v.workDir, status ? { status } : undefined),
    archiveCounts(v.workDir),
    getBacklogLive().snapshot(v.workDir),
  ]);
  return NextResponse.json(
    {
      workDir: v.workDir,
      items: items.map(wire),
      counts: snap.counts,
      resolved: { done: resolved.done, dismissed: resolved.dismissed, total: resolved.done + resolved.dismissed },
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
  const priority = priorityOf(body);
  if (priority === null) {
    return NextResponse.json({ error: `priority must be one of ${BACKLOG_PRIORITIES.join(", ")}` }, { status: 400 });
  }

  const res = await addBacklogItem(v.workDir, {
    title: body.title,
    ...(body.body ? { body: body.body } : {}),
    ...(priority ? { priority } : {}),
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
  /** Field edits (backlog detail view) — priority/body REPLACE the
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
  const priority = priorityOf(body);
  const hasPriority = priority !== undefined;
  const hasBody = body.body !== undefined;
  const hasKind = body.kind !== undefined;
  const hasBlocked = body.blocked !== undefined;
  const hasBlockedOn = body.blockedOn !== undefined;
  if (!hasStatus && !hasPriority && !hasBody && !hasKind && !hasBlocked && !hasBlockedOn) {
    return NextResponse.json(
      { error: "nothing to change — send status, priority, body, kind, blocked and/or blockedOn" },
      { status: 400 },
    );
  }
  if (hasStatus && !(BACKLOG_STATUSES as readonly string[]).includes(body.status!)) {
    return NextResponse.json(
      { error: `status must be one of ${BACKLOG_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }
  if (hasPriority && priority === null) {
    return NextResponse.json(
      { error: `priority must be one of ${BACKLOG_PRIORITIES.join(", ")}` },
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
  if (hasPriority || hasBody || hasKind || hasBlocked || hasBlockedOn) {
    const res = await updateBacklogItem(v.workDir, body.id, {
      ...(priority ? { priority } : {}),
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
