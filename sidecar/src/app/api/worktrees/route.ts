/**
 * GET  /api/worktrees?cwd=…            — implementer worktrees, state derived from git
 * POST /api/worktrees { cwd, action }  — merge one branch locally, or sweep what is spent
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
import { mergeWorktree, reconcileWorktrees, removeWorktree, sweepWorktrees } from "@marvin/runtime/worktrees";
import { type NextRequest, NextResponse } from "next/server";

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
  let body: { cwd?: string; action?: string; slug?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const resolved = await resolveCwd(body.cwd ?? null);
  if (resolved.error) return resolved.error;

  try {
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
    return NextResponse.json({ error: `unknown action ${body.action ?? "(none)"}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
