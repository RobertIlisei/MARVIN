/**
 * The standing merge authorisation (ADR-0134) — the user's side.
 *
 * - GET  /api/supervisor/merge?projectId=…
 *     → { authorisation, ended, holds, branches, running }  the authorisation in
 *       full (target, gate command, holds, zone, expiry), who held what and why,
 *       and what the pass did with each branch.
 * - POST /api/supervisor/merge { projectId, action, … }
 *     action `propose` { target, gate, timeoutSeconds?, holds?, validForHours? }
 *                                     raise the card that shows the target and the gate
 *                                     command in full; the user's click on THAT card
 *                                     creates the authorisation — this route never does
 *     action `revoke`                 end it now; the pass stops before its next branch
 *     action `release-hold` { branch } lift the supervisor's hold on a branch
 *     action `retry`                  look again now (a fast-forward that was waiting)
 *
 * Token-gated like every supervisor route, POST also CSRF-guarded, and under
 * `/api/supervisor` — a control path `supervisorBoundaryDenial` refuses a tab
 * (ADR-0127 §5). No supervisor verb reaches any of it.
 */

import { execFileSync } from "node:child_process";

import { getProject } from "@marvin/runtime/projects";
import { addInboxItem, buildRawAct } from "@marvin/runtime/supervisor-inbox";
import { digestArgs, isSafeProjectId } from "@marvin/runtime/supervisor-ledger";
import { checkMergeProposal, localTimeZone, mergeView, readMerge, releaseHoldAsUser, revokeMerge } from "@marvin/runtime/supervisor-merge";
import { ensureMergeRunner } from "@marvin/runtime/supervisor-merge-pass";
import { getSupervisorState, SUPERVISOR_TOKEN_HEADER, verifySupervisorToken } from "@marvin/runtime/supervisor-state";
import { noteSidecarPort } from "@marvin/tools/policy";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;
const TOKEN_REFUSAL = { error: "supervisor routes need the per-boot capability token (ADR-0127 §5)" };

export async function GET(req: NextRequest) {
  noteSidecarPort(req.nextUrl.port);
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim() ?? "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  if (!getProject(projectId)) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  return NextResponse.json(mergeView(projectId), { headers: { "Cache-Control": "no-store" } });
}

function localBranchExists(workDir: string, branch: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { cwd: workDir, stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  noteSidecarPort(req.nextUrl.port);
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: { projectId?: unknown; action?: unknown; target?: unknown; gate?: unknown; timeoutSeconds?: unknown; holds?: unknown; validForHours?: unknown; branch?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  // The pass hears an approval (from the inbox route) and the changes below on the project event stream.
  const runner = ensureMergeRunner();
  switch (body.action) {
    case "propose": {
      const checked = checkMergeProposal({
        target: body.target,
        gate: body.gate,
        timeoutMs: typeof body.timeoutSeconds === "number" ? body.timeoutSeconds * 1000 : body.timeoutSeconds,
        holds: body.holds,
        validForHours: body.validForHours,
      });
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      const p = checked.proposal;
      if (!localBranchExists(project.workDir, p.target)) return NextResponse.json({ error: `there is no local branch "${p.target}" to merge into` }, { status: 400 });
      const cur = readMerge(projectId).authorisation;
      const replaces = cur ? { target: cur.target, gate: cur.gate } : null;
      const proposal = { ...p, timeZone: localTimeZone() };
      const st = getSupervisorState(projectId);
      const item = addInboxItem(projectId, {
        sessionId: null,
        kind: "queue",
        escalatedBecause: { code: "human-only", label: "Merging is the user's — a standing authorisation is theirs to give", rule: "ADR-0134" },
        rawAct: buildRawAct("propose_merge", { ...proposal }),
        queue: { kind: "merge", proposal, replaces },
        recommendation: { actionId: "approve", text: "You wrote this; approve it here to start it. It merges only into the named local branch and never pushes." },
        grounds: [],
        act: { type: "queue", what: "merge" },
        dedupeKey: `merge-auth:${digestArgs({ ...proposal, at: Date.now() })}`,
        modeAtCreation: st.mode === "autonomous" ? "autonomous" : "shadow",
      });
      return NextResponse.json({ ok: true, itemId: item.id });
    }
    case "revoke":
      if (!revokeMerge(projectId)) return NextResponse.json({ error: "there is no authorisation to revoke" }, { status: 409 });
      // Stops the running pass now: an in-flight gate run is killed and its scratch tree removed.
      runner.stopProject(projectId);
      break;
    case "release-hold": {
      const branch = typeof body.branch === "string" ? body.branch.trim() : "";
      if (!branch || !releaseHoldAsUser(projectId, branch)) return NextResponse.json({ error: `no hold on "${branch}"` }, { status: 404 });
      break;
    }
    case "retry":
      // A fast-forward that was waiting for the user's checkout looks again; with no authorisation the pass does nothing.
      void runner.kick(projectId);
      break;
    default:
      return NextResponse.json({ error: "action must be propose, revoke, release-hold or retry" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, merge: mergeView(projectId) });
}
