/**
 * GET  /api/worktrees?cwd=…            — implementer worktrees, state derived from git
 * POST /api/worktrees { cwd, action }  — merge one branch (or every finished
 *                                        one) locally, or sweep what is spent
 *
 * The surface ADR-0081 never built. Implementers produced branches and nothing
 * ever said so: the only worktree-aware UI was a Source Control row keyed on
 * dirty count, and an implementer that had correctly COMMITTED its work showed
 * a dirty count of 0 — indistinguishable from an empty one. On a real project
 * that left five branches, three of them merged, and 3.1 GB of checkouts.
 *
 * `merge` is deliberately local-only: it never pushes and never opens a PR/MR.
 * On a pipeline-gated project every branch pushed as its own MR costs a full
 * CI run, while merging into the branch the implementer was cut from costs
 * nothing — those commits ride along in the pipeline that branch already runs.
 *
 * See ADR-0103.
 */

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { previewIntegration } from "@marvin/runtime/integration";
import { prepareSessionWorktree, readOrDetectWorktreeSetup } from "@marvin/runtime/worktree-setup";
import { mergeAllWorktrees, mergeWorktree, prepareMergeRequest, reconcileWorktrees, removeWorktree, sweepWorktrees } from "@marvin/runtime/worktrees";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Shared cwd guard — every route in this family runs it before touching git. */
async function resolveCwd(cwd: string | null) {
  if (!cwd) return { error: NextResponse.json({ error: "cwd required" }, { status: 400 }) };
  const sandbox = await checkFsPath({ cwd, target: cwd, mustExist: true, allowDirectory: true });
  if (!sandbox.ok || !sandbox.isDirectory) {
    return { error: NextResponse.json({ error: sandbox.ok ? "cwd is not a directory" : sandbox.error }, { status: 400 }) };
  }
  // Use the canonicalised path: git reports real paths, and a symlinked
  // project would otherwise never match its own checkouts.
  return { cwd: sandbox.absolutePath };
}

export async function GET(req: NextRequest) {
  const resolved = await resolveCwd(req.nextUrl.searchParams.get("cwd"));
  if (resolved.error) return resolved.error;
  try {
    const worktrees = reconcileWorktrees(resolved.cwd);
    return NextResponse.json({ worktrees });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // ADR-0107 — this route mutates branches; it had no CSRF guard.
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: {
    cwd?: string;
    action?: string;
    slug?: string;
    slugs?: unknown;
    name?: unknown;
    message?: unknown;
    push?: unknown;
    openMergeRequest?: unknown;
    target?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const resolved = await resolveCwd(body.cwd ?? null);
  if (resolved.error) return resolved.error;

  try {
    // ADR-0111 — dry-run every finished branch against the current branch.
    if (body.action === "preview") {
      const slugs = Array.isArray(body.slugs) ? body.slugs.filter((x): x is string => typeof x === "string") : undefined;
      return NextResponse.json(previewIntegration(resolved.cwd, { slugs, includeOpen: true }));
    }
    if (body.action === "sweep") {
      return NextResponse.json({ swept: sweepWorktrees(resolved.cwd) });
    }
    // "drop" is the checkout only — the BRANCH survives (ADR-0081). It is how
    // you reclaim disk from a `ready` tree without discarding its work.
    if (body.action === "drop") {
      if (!body.slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
      const out = removeWorktree(resolved.cwd, body.slug);
      // A running implementer is refused, not 404'd — the caller needs to know
      // the checkout is still there and why (ADR-0103 amendment).
      if (out.refused) return NextResponse.json({ ok: false, message: out.refused }, { status: 409 });
      const rec = out.removed;
      return NextResponse.json(
        rec
          ? { ok: true, message: `Removed checkout ${rec.path}; branch ${rec.branch} kept.` }
          : { ok: false, message: `No worktree named ${body.slug}.` },
        { status: rec ? 200 : 404 },
      );
    }
    if (body.action === "merge") {
      if (!body.slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
      const out = mergeWorktree(resolved.cwd, body.slug);
      return NextResponse.json(out, { status: out.ok ? 200 : 409 });
    }
    // ADR-0109 — fold every `ready` branch in one pass. Same local-only rule
    // as `merge`; the point is that N branches still cost one pipeline, not N.
    if (body.action === "merge-all") {
      const out = mergeAllWorktrees(resolved.cwd);
      return NextResponse.json(out, { status: out.stopped ? 409 : 200 });
    }
    // Squash chosen finished branches into ONE commit on an `mr/…` branch;
    // push and MR-open are explicit opt-ins the sheet's own toggles set. The
    // user clicked this — it is not a model turn, so the metered-CI gate
    // (ADR-0109) is the sheet's wording, not a confirm card.
    if (body.action === "prepare-mr") {
      const slugs = Array.isArray(body.slugs) ? body.slugs.filter((s): s is string => typeof s === "string") : [];
      if (slugs.length === 0) return NextResponse.json({ error: "slugs required" }, { status: 400 });
      const target = typeof body.target === "string" ? body.target.trim() : "";
      if (target && !/^[A-Za-z0-9._\/-]{1,120}$/.test(target)) return NextResponse.json({ error: "invalid target" }, { status: 400 });
      const out = await prepareMergeRequest(resolved.cwd, {
        slugs,
        prepare: (path) => prepareSessionWorktree(resolved.cwd, path, readOrDetectWorktreeSetup(resolved.cwd).config),
        ...(typeof body.name === "string" ? { name: body.name.slice(0, 120) } : {}),
        ...(typeof body.message === "string" ? { message: body.message.slice(0, 8000) } : {}),
        push: body.push === true,
        openMergeRequest: body.openMergeRequest === true,
        ...(target ? { target } : {}),
      });
      return NextResponse.json(out, { status: out.ok ? 200 : 409 });
    }
    return NextResponse.json({ error: `unknown action ${body.action ?? "(none)"}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
