/**
 * Integration preview and owner-resolved sync (ADR-0111).
 *
 * ADR-0109 gave the day's tab branches one act — Merge all, or Prepare MR —
 * and stops at the first conflict, which is right. What it left the user
 * holding is the conflict itself: a branch cut from an older HEAD, a merge
 * aborted in the main checkout, and nothing on hand that knows what the
 * branch was trying to do.
 *
 * Two pieces:
 *
 *   previewIntegration — `git merge-tree --write-tree` (git ≥ 2.38) for every
 *     finished branch against the current branch. Nothing is checked out,
 *     nothing moves; the answer is per branch: clean, or the files that would
 *     conflict, plus how far behind the target the branch sits. Merge all and
 *     Prepare MR read the same preview, so the first conflict is known before
 *     the first merge rather than discovered at the third.
 *
 *   syncWithTarget — one turn in the tab's OWN worktree, dispatched through
 *     the resume path, whose job is to merge the target into the branch,
 *     resolve, test, commit — never push. That session has the whole context
 *     of its own changes; the user in the main checkout has none of it.
 */

import { execFileSync } from "node:child_process";
import { readSessionMeta, resolveSessionCwd } from "./session-meta";
import { resumeSession } from "./session-recovery";
import { getLiveTurn } from "./turn-registry";
import { findSessionWorktree, type ReconciledWorktree, reconcileWorktrees } from "./worktrees";

export type IntegrationVerdict = "clean" | "conflict" | "unknown";

export interface IntegrationPreviewRow {
  slug: string;
  branch: string;
  sessionId?: string | undefined;
  task: string;
  state: ReconciledWorktree["state"];
  commits: number;
  added: number;
  removed: number;
  /** Commits on the target the branch does not have. 0 = cut from the current tip. */
  behind: number;
  verdict: IntegrationVerdict;
  /** Paths `git merge-tree` reports as conflicting; empty unless `verdict === "conflict"`. */
  conflicts: string[];
  /** Why the row is not integrable now (open tab, running, empty, merged). */
  skipReason?: string | undefined;
}

export interface IntegrationPreview {
  /** The branch the merges would land on: the main checkout's current branch. */
  target: string;
  targetHead: string;
  /** False when git cannot run `merge-tree --write-tree` (older than 2.38). */
  previewAvailable: boolean;
  rows: IntegrationPreviewRow[];
}

function gitOut(cwd: string, args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer };
    return { status: typeof e.status === "number" ? e.status : -1, stdout: e.stdout ? String(e.stdout) : "" };
  }
}

/**
 * Dry-run one merge. Exit 0 = clean; exit 1 = conflicts, and with
 * `--name-only` the stdout is the would-be tree id, then one conflicted path
 * per line, then a blank line and the informational messages. Anything else
 * (older git, a bad ref) is `unknown`, never a guess.
 */
export function dryRunMerge(workDir: string, target: string, branch: string): { verdict: IntegrationVerdict; conflicts: string[] } {
  // A missing ref ALSO exits 1 ("not something we can merge", on stderr), so
  // both refs are checked first, and a conflict must come with its tree id.
  for (const ref of [target, branch]) {
    if (gitOut(workDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status !== 0) return { verdict: "unknown", conflicts: [] };
  }
  const out = gitOut(workDir, ["merge-tree", "--write-tree", "--name-only", target, branch]);
  if (out.status === 0) return { verdict: "clean", conflicts: [] };
  if (out.status !== 1) return { verdict: "unknown", conflicts: [] };
  const lines = out.stdout.split("\n");
  if (!/^[0-9a-f]{40}$/.test(lines[0]?.trim() ?? "")) return { verdict: "unknown", conflicts: [] };
  const conflicts: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") break;
    conflicts.push(line.trim());
  }
  return { verdict: "conflict", conflicts };
}

function skipReasonFor(w: ReconciledWorktree): string | undefined {
  switch (w.state) {
    case "session":
      return "belongs to an open chat tab — close the tab to decide its branch";
    case "running":
      return "still being built by its implementer";
    case "empty":
      return "has no commits";
    case "merged":
      return `already merged into ${w.mergedInto ?? "another branch"}`;
    default:
      return undefined;
  }
}

/**
 * Preview integrating the chosen branches (default: every `ready` one) into
 * the current branch. Open tabs are listed too, with a skip reason, so the
 * section can show them greyed rather than pretend they do not exist.
 */
export function previewIntegration(workDir: string, opts: { slugs?: string[] | undefined; includeOpen?: boolean | undefined } = {}): IntegrationPreview {
  const target = gitOut(workDir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() || "HEAD";
  const targetHead = gitOut(workDir, ["rev-parse", "HEAD"]).stdout.trim();
  const probe = gitOut(workDir, ["merge-tree", "--write-tree", "HEAD", "HEAD"]);
  const previewAvailable = probe.status === 0;
  const wanted = opts.slugs ? new Set(opts.slugs) : null;
  const rows: IntegrationPreviewRow[] = [];
  for (const w of reconcileWorktrees(workDir)) {
    if (w.kind !== "session" && !wanted) continue;
    if (wanted && !wanted.has(w.slug)) continue;
    if (!wanted && w.state !== "ready" && !(opts.includeOpen && w.state === "session")) continue;
    const behind = Number(gitOut(workDir, ["rev-list", "--count", `${w.branch}..HEAD`]).stdout.trim()) || 0;
    const integrable = w.state === "ready" || w.state === "session";
    const dry = previewAvailable && integrable && w.commits > 0 ? dryRunMerge(workDir, target, w.branch) : { verdict: "unknown" as const, conflicts: [] };
    rows.push({
      slug: w.slug,
      branch: w.branch,
      sessionId: w.sessionId,
      task: w.task,
      state: w.state,
      commits: w.commits,
      added: w.added ?? 0,
      removed: w.removed ?? 0,
      behind,
      verdict: w.commits === 0 ? "clean" : dry.verdict,
      conflicts: dry.conflicts,
      skipReason: skipReasonFor(w),
    });
  }
  rows.sort((a, b) => a.branch.localeCompare(b.branch));
  return { target, targetHead, previewAvailable, rows };
}

/** The Sync turn's instruction. Pure; pinned by tests. */
export function syncPrompt(input: { branch: string; target: string; targetHead: string; conflicts: string[] }): string {
  const files = input.conflicts.length
    ? `The dry run reports conflicts in: ${input.conflicts.slice(0, 20).join(", ")}${input.conflicts.length > 20 ? ", …" : ""}.`
    : "The dry run reports no conflicts, but the branch is behind the target.";
  return (
    `[sync with target] Bring your branch \`${input.branch}\` up to date with \`${input.target}\` (${input.targetHead.slice(0, 7)}) ` +
    `in THIS worktree so it can be integrated cleanly. ${files} ` +
    `Run \`git merge ${input.target}\`; resolve every conflict preserving both the target's intent and this branch's, ` +
    `run the tests relevant to the files you touched, then commit the merge. Do not rebase, do not push, do not open a merge request. ` +
    `Finish with a short list of the files you resolved and how.`
  );
}

export type SyncResult =
  | { ok: true; turnDispatched: true; branch: string; target: string }
  | { ok: false; status: number; code: string; error: string };

/**
 * Dispatch the Sync turn into the session that owns the branch. Refused when
 * the session has no worktree, when a turn is already running in it, or when
 * the worktree is gone. A closed (kept) tab is fine: the turn runs in its
 * tree without reopening the tab; the sweep skips a busy session.
 */
export async function syncWithTarget(projectId: string, marvinSessionId: string, workDir: string): Promise<SyncResult> {
  const live = getLiveTurn(marvinSessionId);
  if (live && !live.ended) return { ok: false, status: 409, code: "turn-live", error: "a turn is already running in this tab — wait for it or stop it first" };
  const meta = readSessionMeta(projectId, marvinSessionId);
  if (!meta || meta.tree.mode !== "worktree") return { ok: false, status: 409, code: "not-isolated", error: "this tab has no worktree to sync" };
  if (!resolveSessionCwd(meta).present) return { ok: false, status: 409, code: "worktree-missing", error: "the tab's worktree is missing" };
  const rec = findSessionWorktree(workDir, marvinSessionId);
  const branch = rec?.branch ?? meta.tree.branch;
  const target = gitOut(workDir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() || "HEAD";
  const targetHead = gitOut(workDir, ["rev-parse", "HEAD"]).stdout.trim();
  if (branch === target) return { ok: false, status: 409, code: "same-branch", error: "the tab is on the target branch already" };
  const dry = dryRunMerge(workDir, target, branch);
  const prompt = syncPrompt({ branch, target, targetHead, conflicts: dry.conflicts });
  const res = await resumeSession(projectId, marvinSessionId, { prompt });
  if (!res.ok) return { ok: false, status: res.status, code: res.code, error: res.error };
  return { ok: true, turnDispatched: true, branch, target };
}
