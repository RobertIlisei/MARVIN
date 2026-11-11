/**
 * The standing merge's pass (ADR-0134) — the RUNTIME merges, never the model.
 *
 * With a user-approved authorisation (`supervisor-merge.ts`), the pass takes
 * each finished tab branch, oldest first, and — in a SCRATCH worktree, never the
 * user's checkout — merges it into a detached copy of `target`'s tip, runs the
 * gate the user approved there, and only on exit 0 fast-forwards `target`.
 *
 * What the pass does, in order, for one branch (`mergeOne`):
 *  - eligibility: the derived worktree state is `ready` (ADR-0103), its tab
 *    closed scope-met (`scopeMetAt`), no uncommitted changes, not held by the
 *    supervisor, and — when its diff touches a hold's glob — inside the window;
 *  - prediction: `git merge-tree` (`dryRunMerge`, the engine of
 *    `previewIntegration`) against `target`'s tip. A conflict is NEVER resolved:
 *    the branch is skipped and the file list goes back to its tab;
 *  - the user's guard command (milestone 5), when one is set, before each gate run;
 *  - a scratch worktree cut detached at the tip, set up like a tab's, and ONE
 *    branch merged `--no-ff` there; the gate runs there with the validated env
 *    map and the user's timeout;
 *  - exit 0, and `target` still at the tip the work was cut from: fast-forward
 *    it. If `target` moved meanwhile the result is discarded and the branch is
 *    retried against the new tip (bounded). Anything else: `target` is not
 *    moved, the scratch tree is removed, and the failing output's tail goes to the tab.
 *
 * Never, and enforced in `argvViolation` on EVERY git argv the pass issues, not
 * by a promise: a push, a tag, a fetch, a reset, a branch deleted or renamed, a
 * force, a rebase, or a ref other than `target` written. The only things it
 * removes are its own scratch worktrees.
 *
 * Woken by the project event stream (a tab closing, a turn ending, an approval,
 * a release) — never a timer. A fast-forward that must wait for the user's
 * checkout is retried at the next event, and the workspace says so.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

import { dryRunMerge } from "./integration";
import { getMarvinDataDir } from "./paths";
import { getProject } from "./projects";
import { closeSession } from "./session-close";
import { listSessionMetas, readSessionMeta } from "./session-meta";
import { appendLedgerEntry, digestArgs, type LedgerEntryInput } from "./supervisor-ledger";
import { activeAuthorisation, type BranchRecord, type BranchStatus, insideWindow, type MergeAuthorisation, noteExpired, readMerge, recordBranch, setRunning } from "./supervisor-merge";
import { type GateOutcome, runGateCommand } from "./supervisor-merge-gate";
import { readQueue } from "./supervisor-queue";
import { runGuardCommand } from "./supervisor-queue-guard";
import { acquireMergeLock, isPidAlive, releaseMergeLock } from "./supervisor-queue-lock";
import { sendAsSupervisor } from "./supervisor-send";
import { getSupervisorState, isSupervisorSessionId, listEnabledSupervisors } from "./supervisor-state";
import { getLiveTurn, type ProjectEvent, subscribeProjectEvents } from "./turn-registry";
import { matchesInclude, prepareSessionWorktree, readWorktreeSetupConfig } from "./worktree-setup";
import { freeDiskBytes, type ReconciledWorktree, reconcileWorktreesAsync, worktreeMinFreeBytes } from "./worktrees";

/** A target that keeps moving under the gate is retried this many times, then the branch waits for the next pass. */
export const MERGE_MAX_ATTEMPTS = 3;
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"] as const;

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

// ── The never-list, as code ─────────────────────────────────────────────────

/**
 * Why this git argv may not be run by the pass, or null. An ALLOWLIST: reads,
 * the scratch worktree's own add/remove/prune, the one `--no-ff` merge in the
 * scratch tree, the `--ff-only` merge in `target`'s checkout, and a ref update
 * whose ref is exactly `refs/heads/<target>` and whose old value is given. A
 * push, tag, fetch, reset, branch delete/rename, rebase, force or any other ref
 * is not in it, so none can be run — and the tests assert it over the argv of
 * real passes as well as over this table.
 */
export function argvViolation(argv: readonly string[], ctx: { target: string; scratchRoot: string }): string | null {
  let args = [...argv];
  // The one global option the pass sets: a repository's hooks are the repository's code, not what the user approved.
  if (args[0] === "-c") {
    if (args[1] !== NO_HOOKS[1]) return `a git -c option other than ${NO_HOOKS[1]}`;
    args = args.slice(2);
  }
  const [cmd, ...rest] = args;
  const underScratch = (p: string | undefined) => !!p && path.resolve(p).startsWith(`${path.resolve(ctx.scratchRoot)}${path.sep}`);
  const sha = (s: string | undefined) => !!s && /^[0-9a-f]{40,64}$/.test(s);
  switch (cmd) {
    case "rev-parse":
    case "merge-tree":
    case "merge-base":
    case "rev-list":
    case "log":
    case "diff":
    case "status":
    case "show-ref":
      return rest.some((a) => /^(--output|-o)(=|$)/.test(a)) ? "a read command that writes" : null;
    case "worktree":
      if (rest[0] === "list" && rest[1] === "--porcelain" && rest.length === 2) return null;
      if (rest[0] === "prune" && rest.length === 1) return null;
      if (rest[0] === "add" && rest[1] === "--detach" && rest.length === 4 && underScratch(rest[2]) && sha(rest[3])) return null;
      if (rest[0] === "remove" && rest[1] === "--force" && rest.length === 3 && underScratch(rest[2])) return null;
      return "a worktree command other than the pass's own scratch add / remove / prune / list";
    case "merge":
      if (rest.length === 1 && rest[0] === "--abort") return null;
      if (rest.length === 2 && rest[0] === "--ff-only" && sha(rest[1])) return null;
      if (rest.length === 4 && rest[0] === "--no-ff" && rest[1] === "-m" && sha(rest[3])) return null;
      return "a merge other than --no-ff of one commit in the scratch tree, or --ff-only";
    case "update-ref":
      if (rest.length === 3 && rest[0] === `refs/heads/${ctx.target}` && sha(rest[1]) && sha(rest[2])) return null;
      return "a ref update other than refs/heads/<target> to a commit, guarded by its old value";
    default:
      return `git ${cmd ?? ""} is not something the standing merge may run (no push, tag, fetch, reset, branch delete, rebase or force)`;
  }
}

// ── Deps ────────────────────────────────────────────────────────────────────

export interface PassDeps {
  pid: number;
  isAlive(pid: number): boolean;
  now(): number;
  workDirOf(projectId: string): string | null;
  /** Why the supervisor cannot act now (off, paused), or null. */
  supervisorRefusal(projectId: string): string | null;
  /** The one place git is run from. Tests wrap it to record every argv. */
  exec(cwd: string, args: string[]): Promise<GitResult>;
  /** ADR-0103's derived state, read from git now. */
  reconcile(workDir: string): Promise<ReconciledWorktree[]>;
  sessionOf(projectId: string, sessionId: string): { scopeMetAt?: string | undefined; closedAt?: string | undefined } | null;
  scratchRoot(projectId: string): string;
  /** Link dependencies into the scratch tree the way a tab's worktree is set up. */
  prepareScratch(workDir: string, scratch: string): void;
  diskRefusal(workDir: string): string | null;
  runGate(workDir: string, cwd: string, command: string, opts: { timeoutMs: number; signal?: AbortSignal | undefined }): Promise<GateOutcome>;
  /** The user-approved guard command of milestone 5, or null; and its run. */
  guardCommand(projectId: string): string | null;
  runGuard(workDir: string, command: string): Promise<{ ok: boolean; detail: string }>;
  /** Why the checkout that holds `target` is in use by something live, or null. */
  checkoutBusy(projectId: string, workDir: string, checkout: string): string | null;
  /** Tell a tab; "recorded" when it cannot be messaged (a closed tab). */
  report(projectId: string, sessionId: string, text: string): Promise<"sent" | "recorded">;
  closeTab(projectId: string, workDir: string, sessionId: string): Promise<{ ok: boolean; message: string }>;
}

function execGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((done) => {
    execFile("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      done({ status: err ? (typeof code === "number" ? code : -1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

export function defaultPassDeps(): PassDeps {
  return {
    pid: process.pid,
    isAlive: isPidAlive,
    now: () => Date.now(),
    workDirOf: (projectId) => getProject(projectId)?.workDir ?? null,
    supervisorRefusal: (projectId) => {
      const s = getSupervisorState(projectId);
      if (s.mode === "off") return "the supervisor is off";
      if (s.paused) return "the supervisor is paused";
      return null;
    },
    exec: execGit,
    reconcile: (workDir) => reconcileWorktreesAsync(workDir),
    sessionOf: (projectId, sessionId) => {
      const m = readSessionMeta(projectId, sessionId);
      return m ? { scopeMetAt: m.scopeMetAt, closedAt: m.closedAt } : null;
    },
    // Outside the repository (the data dir): a scratch tree under `.marvin/worktrees/` would be adopted as an orphan tab tree by the registry, and one under `.marvin/` would make the user's checkout read dirty.
    scratchRoot: (projectId) => path.join(getMarvinDataDir(), "merge-scratch", projectId),
    prepareScratch: (workDir, scratch) => {
      prepareSessionWorktree(workDir, scratch, readWorktreeSetupConfig(workDir));
    },
    diskRefusal: (workDir) => {
      const floor = worktreeMinFreeBytes(readWorktreeSetupConfig(workDir).minFreeGb);
      if (floor <= 0) return null;
      try {
        const free = freeDiskBytes(workDir);
        return free < floor ? `free disk space is below the worktree floor (${Math.round(free / 1024 ** 3)} GB < ${Math.round(floor / 1024 ** 3)} GB)` : null;
      } catch {
        return null;
      }
    },
    runGate: (workDir, cwd, command, opts) => runGateCommand(workDir, cwd, command, opts),
    guardCommand: (projectId) => readQueue(projectId).guard?.command ?? null,
    runGuard: async (workDir, command) => {
      const r = await runGuardCommand(workDir, command);
      return r.ok ? { ok: true, detail: "" } : { ok: false, detail: r.detail };
    },
    checkoutBusy: (projectId, workDir, checkout) => {
      const main = real(workDir) === real(checkout);
      for (const m of listSessionMetas(projectId)) {
        const live = getLiveTurn(m.marvinSessionId);
        if (!live || live.ended || isSupervisorSessionId(m.marvinSessionId)) continue;
        if (main && m.tree.mode !== "worktree") return `a turn is running in the shared checkout (tab ${m.marvinSessionId.slice(0, 8)}, ADR-0102)`;
        if (!main && m.tree.mode === "worktree" && real(m.tree.path) === real(checkout)) return `a turn is running in that checkout (tab ${m.marvinSessionId.slice(0, 8)})`;
      }
      return null;
    },
    report: async (projectId, sessionId, text) => {
      const r = await sendAsSupervisor({ projectId, marvinSessionId: sessionId, text, kind: "instruction", grounds: [] });
      return r.ok ? "sent" : "recorded";
    },
    closeTab: async (projectId, workDir, sessionId) => {
      const out = await closeSession({ projectId, workDir, sessionId, action: "keep" });
      return out.status === 200 ? { ok: true, message: String(out.body.message ?? "closed") } : { ok: false, message: String(out.body.error ?? "could not close") };
    },
  };
}

const led = (projectId: string, line: Pick<LedgerEntryInput, "verb" | "decision" | "reason"> & Partial<LedgerEntryInput>): void => {
  try {
    appendLedgerEntry(projectId, { kind: "control", tab: null, wakeId: null, ...line });
  } catch {
    /* a ledger write must not stop the pass; the branch record says the same */
  }
};

const tailOf = (s: string, n = 1500) => (s.length > n ? `…${s.slice(-n)}` : s);

export interface PassResult {
  merged: string[];
  skipped: string[];
  /** Why the pass ended early: "revoked", "expired", "guard", "waiting", "target-missing", "paused", … */
  stopped?: string;
  lock: "ours" | "held" | "none";
}

interface Waiting {
  branch: string;
  sessionId: string | undefined;
  commit: string;
  /** The `target` tip the work was cut from; the fast-forward is valid only while `target` is still here. */
  tip: string;
  scratch: string;
}

type Attempt = { kind: "merged" | "skipped" | "waiting" | "retry" | "stop"; stop?: string };

// ── The pass ────────────────────────────────────────────────────────────────

export class MergePass {
  /** A tested merge commit whose fast-forward is waiting for the user's checkout; its scratch tree is kept. */
  readonly waiting = new Map<string, Waiting>();

  constructor(readonly deps: PassDeps) {}

  private async git(ctx: { target: string; scratchRoot: string }, cwd: string, args: string[]): Promise<GitResult> {
    const why = argvViolation(args, ctx);
    if (why) throw new Error(`refused a git command the standing merge may not run: ${why} — ${args.join(" ").slice(0, 120)}`);
    return this.deps.exec(cwd, args);
  }

  /** Remove one scratch tree and nothing else: git's registration, the directory (a symlink in it is removed, never followed), the admin entry. */
  private async removeScratch(projectId: string, workDir: string, ctx: { target: string; scratchRoot: string }, scratch: string): Promise<void> {
    const root = path.resolve(ctx.scratchRoot);
    if (!path.resolve(scratch).startsWith(`${root}${path.sep}`)) return;
    try {
      await this.git(ctx, workDir, ["worktree", "remove", "--force", scratch]);
    } catch {
      /* not registered (a pass killed before `add` finished), or already gone */
    }
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best effort; the next pass start removes what is left */
    }
    try {
      await this.git(ctx, workDir, ["worktree", "prune"]);
    } catch {
      /* best effort */
    }
    void projectId;
  }

  /** A scratch tree left by a killed pass is removed at the next pass start (ADR-0134 invariant 9). */
  async removeLeftovers(projectId: string, workDir: string, target: string): Promise<string[]> {
    const root = this.deps.scratchRoot(projectId);
    if (!existsSync(root)) return [];
    const keep = this.waiting.get(projectId)?.scratch;
    const ctx = { target, scratchRoot: root };
    const removed: string[] = [];
    for (const name of readdirSync(root)) {
      const dir = path.join(root, name);
      if (keep && path.resolve(keep) === path.resolve(dir)) continue;
      await this.removeScratch(projectId, workDir, ctx, dir);
      removed.push(dir);
    }
    if (removed.length) led(projectId, { verb: "merge.cleanup", decision: "act", reason: `removed ${removed.length} scratch worktree${removed.length === 1 ? "" : "s"} a killed pass left behind`, reasonCode: "scratch-leftover" });
    return removed;
  }

  private note(projectId: string, rec: Omit<BranchRecord, "at">): void {
    const cur = readMerge(projectId).branches.find((b) => b.branch === rec.branch);
    if (cur && cur.status === rec.status && cur.code === rec.code && cur.reason === rec.reason && cur.commit === rec.commit) return;
    recordBranch(projectId, { ...rec, at: new Date(this.deps.now()).toISOString() });
  }

  /** One pass: every eligible branch, oldest first, until none is left or something stops it. Never throws. */
  async run(projectId: string, signal?: AbortSignal): Promise<PassResult> {
    const result: PassResult = { merged: [], skipped: [], lock: "none" };
    const workDir = this.deps.workDirOf(projectId);
    if (!workDir) return result;
    // A leftover from a killed pass goes first, whatever the authorisation says.
    const known = readMerge(projectId).authorisation;
    const rootCtx = { target: known?.target ?? "-", scratchRoot: this.deps.scratchRoot(projectId) };
    try {
      if (!this.waiting.has(projectId)) await this.removeLeftovers(projectId, workDir, rootCtx.target);
    } catch {
      /* best effort */
    }
    if (noteExpired(projectId, this.deps.now())) {
      led(projectId, { verb: "merge.expired", decision: "drop", reason: "the standing merge authorisation expired — nothing merges until the user approves a new one", reasonCode: "expired" });
      await this.dropWaiting(projectId, workDir, rootCtx);
    }
    const auth = activeAuthorisation(projectId, this.deps.now());
    if (!auth) {
      await this.dropWaiting(projectId, workDir, rootCtx);
      return result;
    }
    const refusal = this.deps.supervisorRefusal(projectId);
    if (refusal) {
      result.stopped = "paused";
      return result;
    }
    if (acquireMergeLock(projectId, { pid: this.deps.pid, isAlive: this.deps.isAlive }) === "held") {
      led(projectId, { verb: "merge.refused", decision: "refuse", reason: "another process holds this project's merge-pass lock — this one merges nothing", reasonCode: "lock-held" });
      result.lock = "held";
      return result;
    }
    result.lock = "ours";
    try {
      await this.loop(projectId, workDir, auth, result, signal);
    } catch (err) {
      led(projectId, { verb: "merge.error", decision: "refuse", reason: `the merge pass failed: ${(err as Error).message.slice(0, 300)}`, reasonCode: "pass-error" });
      result.stopped = "error";
    } finally {
      try {
        setRunning(projectId, null);
      } catch {
        /* the record is advisory */
      }
      releaseMergeLock(projectId, this.deps.pid);
    }
    return result;
  }

  private async dropWaiting(projectId: string, workDir: string, ctx: { target: string; scratchRoot: string }): Promise<void> {
    const w = this.waiting.get(projectId);
    if (!w) return;
    this.waiting.delete(projectId);
    await this.removeScratch(projectId, workDir, ctx, w.scratch);
  }

  /** Is the pass still allowed to continue? The authorisation is read from the file every time — a revoke or an expiry stops it before the next branch. */
  private ended(projectId: string, signal: AbortSignal | undefined): "revoked" | "expired" | null {
    if (signal?.aborted) return "revoked";
    if (activeAuthorisation(projectId, this.deps.now())) return null;
    return readMerge(projectId).authorisation ? "expired" : "revoked";
  }

  private async loop(projectId: string, workDir: string, auth: MergeAuthorisation, result: PassResult, signal: AbortSignal | undefined): Promise<void> {
    const ctx = { target: auth.target, scratchRoot: this.deps.scratchRoot(projectId) };
    const decided = new Set<string>();
    // A tested commit that was waiting for the user's checkout goes first: one branch at a time.
    if (this.waiting.has(projectId)) {
      const r = await this.resumeWaiting(projectId, workDir, auth, ctx);
      if (r === "merged") result.merged.push(this.lastMerged ?? "");
      else if (r === "waiting") {
        result.stopped = "waiting";
        return;
      }
    }
    for (let guard = 0; guard < 500; guard++) {
      const why = this.ended(projectId, signal);
      if (why) {
        led(projectId, { verb: `merge.${why}`, decision: "drop", reason: `the pass stopped before its next branch: the authorisation was ${why}`, reasonCode: why });
        result.stopped = why;
        return;
      }
      const rows = (await this.deps.reconcile(workDir)).filter((w) => w.state === "ready" && !decided.has(w.branch));
      rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.branch.localeCompare(b.branch)));
      const row = rows[0];
      if (!row) return;
      decided.add(row.branch);
      const skip = this.eligibility(projectId, auth, row);
      if (skip) {
        this.skip(projectId, row, skip.status, skip.code, skip.reason);
        result.skipped.push(row.branch);
        continue;
      }
      const out = await this.mergeOne(projectId, workDir, auth, ctx, row, signal);
      if (out.kind === "merged") result.merged.push(row.branch);
      else if (out.kind === "skipped" || out.kind === "retry") result.skipped.push(row.branch);
      else {
        if (out.kind === "stop" || out.kind === "waiting") result.stopped = out.stop ?? out.kind;
        return;
      }
    }
  }

  private lastMerged: string | null = null;

  /** The cheap checks, no git: invariant 4 and the supervisor's hold. */
  private eligibility(projectId: string, auth: MergeAuthorisation, row: ReconciledWorktree): { status: BranchStatus; code: string; reason: string } | null {
    if (row.branch === auth.target) return { status: "skipped", code: "is-target", reason: "this is the target branch itself" };
    if (row.kind !== "session" || !row.sessionId) return { status: "skipped", code: "not-a-tab", reason: "not a chat tab's branch — only a tab that closed its scope merges on its own" };
    const meta = this.deps.sessionOf(projectId, row.sessionId);
    if (!meta) return { status: "skipped", code: "no-session", reason: "its tab's record is missing, so it cannot be shown to have closed its scope" };
    if (!meta.scopeMetAt) return { status: "skipped", code: "scope-not-met", reason: "its tab did not close scope-met — the user decides this branch" };
    if (row.dirty) return { status: "skipped", code: "dirty", reason: "its worktree has uncommitted changes" };
    const hold = readMerge(projectId).holds.find((h) => h.branch === row.branch);
    if (hold) return { status: "held", code: "supervisor-hold", reason: `held by the supervisor: ${hold.reason}` };
    return null;
  }

  private skip(projectId: string, row: ReconciledWorktree, status: BranchStatus, code: string, reason: string, extra: Partial<BranchRecord> = {}): void {
    this.note(projectId, { branch: row.branch, status, code, reason, ...extra });
    led(projectId, { verb: status === "held" ? "merge.held" : "merge.skipped", decision: "refuse", reason: `${row.branch}: ${reason}`, reasonCode: code, argsDigest: digestArgs({ branch: row.branch }), ...(row.sessionId ? { tab: row.sessionId } : {}) });
  }

  private async tell(projectId: string, row: ReconciledWorktree, text: string): Promise<"sent" | "recorded"> {
    if (!row.sessionId) return "recorded";
    try {
      return await this.deps.report(projectId, row.sessionId, text);
    } catch {
      return "recorded";
    }
  }

  private async mergeOne(
    projectId: string,
    workDir: string,
    auth: MergeAuthorisation,
    ctx: { target: string; scratchRoot: string },
    row: ReconciledWorktree,
    signal: AbortSignal | undefined,
  ): Promise<Attempt> {
    for (let attempt = 1; attempt <= MERGE_MAX_ATTEMPTS; attempt++) {
      const out = await this.attempt(projectId, workDir, auth, ctx, row, signal, attempt);
      if (out.kind !== "retry") return out;
    }
    this.skip(projectId, row, "skipped", "target-moving", `${auth.target} moved under the gate ${MERGE_MAX_ATTEMPTS} times — the branch waits for the next pass`);
    return { kind: "skipped" };
  }

  private async attempt(
    projectId: string,
    workDir: string,
    auth: MergeAuthorisation,
    ctx: { target: string; scratchRoot: string },
    row: ReconciledWorktree,
    signal: AbortSignal | undefined,
    attempt: number,
  ): Promise<Attempt> {
    const branch = row.branch;
    const tab = row.sessionId ? { tab: row.sessionId } : {};
    const stage = (s: "predicting" | "merging" | "gate" | "advancing") => setRunning(projectId, { branch, stage: s, startedAt: new Date(this.deps.now()).toISOString() });
    const tipOf = async (ref: string) => {
      const r = await this.git(ctx, workDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}^{commit}`]);
      return r.status === 0 ? r.stdout.trim() : "";
    };
    const tip = await tipOf(auth.target);
    if (!tip) {
      this.note(projectId, { branch, status: "waiting", code: "target-missing", reason: `the target branch "${auth.target}" does not exist locally` });
      led(projectId, { verb: "merge.refused", decision: "refuse", reason: `the target branch "${auth.target}" does not exist locally — the pass stops`, reasonCode: "target-missing" });
      return { kind: "stop", stop: "target-missing" };
    }
    const branchTip = await tipOf(branch);
    if (!branchTip) {
      this.skip(projectId, row, "skipped", "branch-gone", "the branch no longer exists");
      return { kind: "skipped" };
    }

    // Holds by path and window: the diff against where the branch leaves target.
    stage("predicting");
    if (auth.holds.length) {
      const names = (await this.git(ctx, workDir, ["diff", "--name-only", `${tip}...${branchTip}`])).stdout.split("\n").filter(Boolean);
      const now = new Date(this.deps.now());
      for (const h of auth.holds) {
        if (names.some((n) => matchesInclude(h.pathGlob, n)) && !insideWindow(h.window, now)) {
          this.skip(projectId, row, "held", "window", `touches ${h.pathGlob} — merges only ${h.window.from}–${h.window.to} (${auth.timeZone || "local time"})`);
          return { kind: "skipped" };
        }
      }
    }

    // Predict first; a conflict is never resolved, it goes back to the tab.
    const dry = await dryRunMerge(workDir, tip, branchTip, (cwd, args) => this.git(ctx, cwd, args));
    led(projectId, { verb: "merge.predicted", decision: "act", reason: `${branch} into ${auth.target}: ${dry.verdict}${dry.conflicts.length ? ` (${dry.conflicts.join(", ")})` : ""}`, reasonCode: `predict-${dry.verdict}`, argsDigest: digestArgs({ branch }), ...tab });
    if (dry.verdict === "conflict") {
      const text =
        `Your branch ${branch} conflicts with ${auth.target} in: ${dry.conflicts.slice(0, 30).join(", ")}${dry.conflicts.length > 30 ? ", …" : ""}. ` +
        `The standing merge never resolves a conflict, so it did not try; no gate run was spent. Bring ${auth.target} into your branch, resolve, and finish again.`;
      const reported = await this.tell(projectId, row, text);
      this.skip(projectId, row, "skipped", "conflict", `would conflict in ${dry.conflicts.length} file${dry.conflicts.length === 1 ? "" : "s"}`, { prediction: "conflict", report: text, reported });
      return { kind: "skipped" };
    }
    if (dry.verdict === "unknown") {
      this.skip(projectId, row, "skipped", "predict-unknown", "git could not predict the merge — never guessed", { prediction: "unknown" });
      return { kind: "skipped" };
    }

    // The user's guard (milestone 5): load-wait before a gate run. A non-zero exit holds the pass until the next event.
    const guardCmd = this.deps.guardCommand(projectId);
    if (guardCmd) {
      const g = await this.deps.runGuard(workDir, guardCmd);
      if (!g.ok) {
        this.note(projectId, { branch, status: "waiting", code: "guard", reason: `the guard command held the gate run (${g.detail})`, prediction: "clean" });
        led(projectId, { verb: "merge.waiting", decision: "refuse", reason: `${branch}: the guard command ${g.detail} — the pass waits for the next event`, reasonCode: "guard", ...tab });
        return { kind: "stop", stop: "guard" };
      }
    }
    const disk = this.deps.diskRefusal(workDir);
    if (disk) {
      this.note(projectId, { branch, status: "waiting", code: "disk", reason: disk, prediction: "clean" });
      return { kind: "stop", stop: "disk" };
    }

    // The scratch worktree: detached at the tip, set up like a tab's.
    stage("merging");
    mkdirSync(ctx.scratchRoot, { recursive: true });
    const scratch = path.join(ctx.scratchRoot, `${this.deps.now().toString(36)}-${attempt}-${Math.random().toString(36).slice(2, 8)}`);
    const discard = () => this.removeScratch(projectId, workDir, ctx, scratch);
    try {
      const added = await this.git(ctx, workDir, ["worktree", "add", "--detach", scratch, tip]);
      if (added.status !== 0) {
        this.note(projectId, { branch, status: "failed", code: "scratch-failed", reason: `could not make the scratch worktree: ${tailOf(added.stderr, 300)}`, prediction: "clean" });
        await discard();
        return { kind: "stop", stop: "scratch-failed" };
      }
      this.deps.prepareScratch(workDir, scratch);
      const merged = await this.git(ctx, scratch, [...NO_HOOKS, "merge", "--no-ff", "-m", `Merge branch '${branch}' into ${auth.target} (MARVIN standing merge)`, branchTip]);
      if (merged.status !== 0) {
        await this.git(ctx, scratch, ["merge", "--abort"]).catch(() => undefined);
        const text = `Your branch ${branch} did not merge into ${auth.target} although git predicted it would: ${tailOf(`${merged.stdout}\n${merged.stderr}`.trim(), 800)}`;
        const reported = await this.tell(projectId, row, text);
        this.note(projectId, { branch, status: "failed", code: "merge-failed", reason: "the merge failed in the scratch tree — nothing moved", prediction: "clean", report: text, reported });
        led(projectId, { verb: "merge.failed", decision: "refuse", reason: `${branch}: the merge failed in the scratch tree`, reasonCode: "merge-failed", ...tab });
        await discard();
        return { kind: "skipped" };
      }
      const commit = (await this.git(ctx, scratch, ["rev-parse", "HEAD"])).stdout.trim();

      // The gate, in the scratch tree, bounded by the user's timeout and by the authorisation's own expiry.
      stage("gate");
      const remaining = Date.parse(auth.expiresAt) - this.deps.now();
      const timeoutMs = Math.max(1000, Math.min(auth.timeoutMs, remaining));
      const gate = await this.deps.runGate(workDir, scratch, auth.gate, { timeoutMs, signal });
      const gateExit = gate.ok ? 0 : gate.exitCode;
      led(projectId, {
        verb: "merge.gate",
        decision: gate.ok ? "act" : "refuse",
        reason: `${branch}: the gate ${gate.ok ? "exited 0" : gate.timedOut ? "timed out" : gate.aborted ? "was stopped" : `exited ${gate.exitCode ?? "without a code"}`}`,
        reasonCode: gate.ok ? "gate-ok" : gate.timedOut ? "gate-timeout" : gate.aborted ? "gate-aborted" : "gate-failed",
        argsDigest: digestArgs({ branch, commit }),
        ...tab,
      });
      const ended = this.ended(projectId, signal);
      if (!gate.ok && (gate.aborted || ended)) {
        this.note(projectId, { branch, status: "skipped", code: "authorisation-ended", reason: `the authorisation ${ended ?? "ended"} while the gate ran — it was stopped and nothing moved`, prediction: "clean", gateExit });
        await discard();
        return { kind: "stop", stop: ended ?? "revoked" };
      }
      if (!gate.ok) {
        const text = `Your branch ${branch} merged into ${auth.target} cleanly but the gate failed (${gate.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exit ${gate.exitCode}`}); ${auth.target} was not moved. The end of its output:\n${tailOf(gate.tail)}`;
        const reported = await this.tell(projectId, row, text);
        this.note(projectId, { branch, status: "failed", code: "gate-failed", reason: `the gate ${gate.timedOut ? "timed out" : `exited ${gate.exitCode}`} — ${auth.target} was not moved`, prediction: "clean", gateExit, commit, report: text, reported });
        await discard();
        return { kind: "skipped" };
      }
      if (ended) {
        this.note(projectId, { branch, status: "skipped", code: "authorisation-ended", reason: `the authorisation ${ended} after the gate passed — nothing moved`, prediction: "clean", gateExit, commit });
        await discard();
        return { kind: "stop", stop: ended };
      }

      // Invariant 7: the commit that was tested must be the one that lands.
      stage("advancing");
      if ((await tipOf(auth.target)) !== tip) {
        led(projectId, { verb: "merge.retry", decision: "drop", reason: `${branch}: ${auth.target} moved while the gate ran (attempt ${attempt}) — the result is discarded and the branch retried against the new tip`, reasonCode: "target-moved", ...tab });
        await discard();
        return { kind: "retry" };
      }
      const adv = await this.advance(projectId, workDir, auth, ctx, { branch, sessionId: row.sessionId, commit, tip, scratch });
      if (adv === "waiting") {
        // The tested commit is kept (its scratch tree holds it) until the user's checkout frees up.
        this.waiting.set(projectId, { branch, sessionId: row.sessionId, commit, tip, scratch });
        return { kind: "waiting", stop: "waiting" };
      }
      if (adv === "moved") {
        await discard();
        return { kind: "retry" };
      }
      await discard();
      await this.afterMerge(projectId, workDir, auth, row, commit, gateExit);
      this.lastMerged = branch;
      return { kind: "merged" };
    } catch (err) {
      await discard();
      this.note(projectId, { branch, status: "failed", code: "pass-error", reason: `the pass failed on this branch: ${(err as Error).message.slice(0, 300)}`, prediction: "clean" });
      led(projectId, { verb: "merge.error", decision: "refuse", reason: `${branch}: ${(err as Error).message.slice(0, 300)}`, reasonCode: "pass-error", ...tab });
      return { kind: "skipped" };
    }
  }

  /** Where `target` is checked out, if anywhere (the scratch tree is detached, so never). */
  private async checkoutOf(ctx: { target: string; scratchRoot: string }, workDir: string): Promise<string | null> {
    const out = (await this.git(ctx, workDir, ["worktree", "list", "--porcelain"])).stdout;
    for (const block of out.split("\n\n")) {
      const lines = block.split("\n");
      if (lines.some((l) => l === `branch refs/heads/${ctx.target}`)) return lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length) ?? null;
    }
    return null;
  }

  /**
   * Invariant 8: only a fast-forward. Where `target` is checked out, `merge
   * --ff-only` in THAT checkout (so its files follow its tip — never a reset,
   * never an `update-ref` under a checked-out branch), and only while it has no
   * uncommitted changes and nothing live runs in it; otherwise `waiting`. Where
   * it is checked out nowhere, a guarded `update-ref`.
   */
  private async advance(
    projectId: string,
    workDir: string,
    auth: MergeAuthorisation,
    ctx: { target: string; scratchRoot: string },
    w: Waiting,
  ): Promise<"merged" | "waiting" | "moved"> {
    const tip = (await this.git(ctx, workDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${auth.target}^{commit}`])).stdout.trim();
    if (tip !== w.tip) return "moved";
    const checkout = await this.checkoutOf(ctx, workDir);
    const wait = (reason: string) => {
      this.note(projectId, { branch: w.branch, status: "waiting", code: "checkout-busy", reason: `tested and ready — waiting to fast-forward ${auth.target}: ${reason}`, prediction: "clean", gateExit: 0, commit: w.commit });
      led(projectId, { verb: "merge.waiting", decision: "refuse", reason: `${w.branch}: the gate passed; the fast-forward of ${auth.target} waits — ${reason}`, reasonCode: "checkout-busy", ...(w.sessionId ? { tab: w.sessionId } : {}) });
      return "waiting" as const;
    };
    if (checkout) {
      const dirty = (await this.git(ctx, checkout, ["status", "--porcelain", "--untracked-files=no"])).stdout.trim();
      if (dirty) return wait(`${path.basename(checkout) || "the checkout"} that has ${auth.target} checked out has uncommitted changes`);
      const busy = this.deps.checkoutBusy(projectId, workDir, checkout);
      if (busy) return wait(busy);
      const ff = await this.git(ctx, checkout, [...NO_HOOKS, "merge", "--ff-only", w.commit]);
      if (ff.status !== 0) return wait(`git refused the fast-forward (${tailOf(ff.stderr.trim(), 200)})`);
      return "merged";
    }
    const upd = await this.git(ctx, workDir, ["update-ref", `refs/heads/${auth.target}`, w.commit, w.tip]);
    return upd.status === 0 ? "merged" : "moved";
  }

  /** A waiting fast-forward, tried again at the next event: valid only while `target` has not moved. */
  private async resumeWaiting(projectId: string, workDir: string, auth: MergeAuthorisation, ctx: { target: string; scratchRoot: string }): Promise<"merged" | "waiting" | "moved"> {
    const w = this.waiting.get(projectId) as Waiting;
    const why = this.ended(projectId, undefined);
    if (why) {
      await this.dropWaiting(projectId, workDir, ctx);
      return "moved";
    }
    const adv = await this.advance(projectId, workDir, auth, ctx, w);
    if (adv === "waiting") return "waiting";
    this.waiting.delete(projectId);
    await this.removeScratch(projectId, workDir, ctx, w.scratch);
    if (adv === "moved") {
      led(projectId, { verb: "merge.retry", decision: "drop", reason: `${w.branch}: ${auth.target} moved while the fast-forward waited — the tested commit is discarded and the branch retried`, reasonCode: "target-moved" });
      return "moved";
    }
    const row = (await this.deps.reconcile(workDir)).find((r) => r.branch === w.branch) ?? ({ branch: w.branch, sessionId: w.sessionId, dirty: false } as ReconciledWorktree);
    await this.afterMerge(projectId, workDir, auth, row, w.commit, 0);
    this.lastMerged = w.branch;
    return "merged";
  }

  /** Decision 5: the tab is closed (its branch kept) only when its last turn closed scope-met and its tree is clean; otherwise left open and listed. */
  private async afterMerge(projectId: string, workDir: string, auth: MergeAuthorisation, row: ReconciledWorktree, commit: string, gateExit: number | null): Promise<void> {
    let tab = "no tab to close";
    if (row.sessionId) {
      // Both facts are read again NOW: the gate ran for minutes, and a tab that was clean and scope-met before it may not be after.
      const meta = this.deps.sessionOf(projectId, row.sessionId);
      const fresh = (await this.deps.reconcile(workDir)).find((r) => r.branch === row.branch);
      const dirty = fresh?.dirty ?? row.dirty;
      if (!meta) tab = "tab not found — left as it is";
      else if (meta.closedAt) tab = "tab already closed";
      else if (!meta.scopeMetAt) tab = "tab left open: its last turn did not close its scope";
      else if (dirty) tab = "tab left open: its worktree has uncommitted changes";
      else {
        const c = await this.deps.closeTab(projectId, workDir, row.sessionId);
        tab = c.ok ? "tab closed (branch kept)" : `tab left open: ${c.message}`;
      }
    }
    this.note(projectId, { branch: row.branch, status: "merged", code: "merged", reason: `merged into ${auth.target} after the gate exited 0`, prediction: "clean", gateExit, commit, tab });
    led(projectId, {
      verb: "merge.merged",
      decision: "act",
      reason: `${row.branch} merged into ${auth.target} at ${commit.slice(0, 10)} (gate exit ${gateExit}); ${tab}`,
      reasonCode: "merged",
      argsDigest: digestArgs({ branch: row.branch, commit }),
      ...(row.sessionId ? { tab: row.sessionId } : {}),
    });
  }
}

// ── The runner: events in, one pass at a time ───────────────────────────────

export class MergeRunner {
  private readonly running = new Set<string>();
  private readonly again = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private unsub: (() => void) | null = null;

  constructor(readonly pass: MergePass) {}

  /** Subscribe to the project event stream; one look per project at start for the supervisors already on. */
  start(subscribe: (l: (e: ProjectEvent) => void) => () => void = subscribeProjectEvents, projects: () => string[] = () => listEnabledSupervisors().map((s) => s.projectId)): void {
    if (this.unsub) return;
    this.unsub = subscribe((e) => {
      const d = e.data as { projectId?: string; change?: string };
      if (!d.projectId) return;
      if (e.event === "supervisor.merge") {
        if (d.change === "revoked") this.stopProject(d.projectId);
        // The pass's own bookkeeping (`branch`, `running`) is not a reason to look again.
        if (["approved", "released"].includes(d.change ?? "")) void this.kick(d.projectId);
        return;
      }
      if (e.event === "session.closed" || e.event === "turn.ended" || e.event === "supervisor.state") void this.kick(d.projectId);
    });
    for (const p of projects()) void this.kick(p);
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /** The user revoked: abort the running pass (an in-flight gate run is killed, its scratch tree removed). */
  stopProject(projectId: string): void {
    this.controllers.get(projectId)?.abort();
  }

  /** Look at the project now. Passes never overlap in a process: a kick during a pass asks for one more when it ends. */
  async kick(projectId: string): Promise<PassResult | null> {
    if (this.running.has(projectId)) {
      this.again.add(projectId);
      return null;
    }
    this.running.add(projectId);
    let last: PassResult | null = null;
    try {
      do {
        this.again.delete(projectId);
        const ac = new AbortController();
        this.controllers.set(projectId, ac);
        last = await this.pass.run(projectId, ac.signal);
      } while (this.again.has(projectId));
    } catch (err) {
      led(projectId, { verb: "merge.error", decision: "refuse", reason: `the merge runner failed: ${(err as Error).message.slice(0, 200)}`, reasonCode: "runner-error" });
    } finally {
      this.controllers.delete(projectId);
      this.running.delete(projectId);
    }
    return last;
  }
}

const G = globalThis as typeof globalThis & { __marvinMergeRunner?: MergeRunner };

/** The process's merge runner, started on first call (from the supervisor loop's own start). */
export function ensureMergeRunner(): MergeRunner {
  if (!G.__marvinMergeRunner) {
    G.__marvinMergeRunner = new MergeRunner(new MergePass(defaultPassDeps()));
    G.__marvinMergeRunner.start();
  }
  return G.__marvinMergeRunner;
}
