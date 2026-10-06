/**
 * Worktrees — the isolated working trees MARVIN hands to implementer
 * subagents (ADR-0081).
 *
 * Golden Rule 1 bans model-dispatching-model on SHARED state. A git worktree
 * removes the shared state: an implementer edits its own checkout of its own
 * branch, and the only thing that reaches the main tree is a branch the user
 * merges. MARVIN creates the worktree and names the branch — never the
 * subagent. Anthropic's 2026-08-13 multiagent paper found 18 of 30 agents
 * choosing the identical branch name; the fix is to take the choice away.
 *
 * Why MARVIN creates it rather than the SDK: `EnterWorktree` is refused
 * inside a subagent ("would mutate the parent session's process-wide working
 * directory" — verified 2026-08-29), and the `cwd` input on the Agent tool is
 * accepted but not honoured (Sonnet passed it correctly; the subagent still
 * ran in the main tree). So the worktree lives under the project, the gate
 * sees absolute paths, and containment is enforced there.
 *
 * Layout: `<workDir>/.marvin/worktrees/<slug>` on branch `marvin/<slug>`,
 * registered in `<workDir>/.marvin/worktrees.json`. The worktree directory is
 * added to `.git/info/exclude` so the nested checkout does not show as an
 * untracked directory in the main tree — without touching the user's
 * `.gitignore`.
 */

import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { toolPolicy } from "@marvin/tools/policy";

import { finishIntegrationJob, getIntegrationJob, noteIntegrationProgress, startIntegrationJob } from "./integration-job";

/**
 * Lifecycle of one worktree. Everything except `running` is DERIVED from git
 * on read, never trusted from the registry — the user merges in a terminal,
 * in another session, or by hand, and MARVIN is not there to see it. A state
 * we only recorded would be wrong the moment that happened (ADR-0103).
 */
export type WorktreeState = "running" | "session" | "empty" | "ready" | "merged";

/** ADR-0107 — who the tree belongs to. Absent on pre-0107 records = implementer. */
export type WorktreeKind = "implementer" | "session";

export interface WorktreeRecord {
  slug: string;
  /** Absolute path of the checkout. */
  path: string;
  branch: string;
  /** Commit the branch was cut from. */
  base: string;
  /**
   * Branch HEAD was on when the tree was cut (`main`, a feature branch…).
   * `base` alone is a sha nobody can place; the popover shows this beside
   * it. Absent when HEAD was detached, and on records from before 2026-09-10.
   */
  baseRef?: string;
  createdAt: string;
  /** One line: what the implementer was asked to do, or the chat tab's title. */
  task: string;
  /** ADR-0107 — implementer (default) or a chat session's own tree. */
  kind?: WorktreeKind;
  /** ADR-0107 — the marvinSessionId a `session` tree belongs to. */
  sessionId?: string;
  /** SDK `task_id` of the implementer bound to this tree, once dispatched. */
  taskId?: string;
  /** Set when the implementer's `task_notification` lands. */
  finishedAt?: string;
  /** ADR-0111 — the branch was renamed from its first commit subject; done once. */
  named?: boolean;
  /** Last derived state, cached for surfaces that read the file directly. */
  state?: WorktreeState;
  /** Ref the branch was found merged into, when `state === "merged"`. */
  mergedInto?: string;
}

/** A record plus everything derived from git at read time. */
export interface ReconciledWorktree extends WorktreeRecord {
  state: WorktreeState;
  /** Commits on the branch that are not on its base. */
  commits: number;
  filesChanged: number;
  /** Uncommitted or untracked work in the checkout. Blocks every cleanup. */
  dirty: boolean;
  /** False once the checkout has been removed but the branch survives. */
  checkoutPresent: boolean;
  /** ISO date of the branch tip — what "latest branches I worked on" sorts by. */
  lastCommitAt?: string;
  /** Lines added / removed against the base. Only computed for unmerged work. */
  added?: number;
  removed?: number;
}

const REGISTRY = "worktrees.json";
const DIR = "worktrees";
const BRANCH_PREFIX = "marvin/";
/** ADR-0107 — session trees get their own prefixes so a lost record can be
 *  classified from the ref name alone, and never swept as an orphan. */
export const SESSION_BRANCH_PREFIX = "marvin/tab/";
export const SESSION_DIR_PREFIX = "tab-";

export function worktreesDir(workDir: string): string {
  return join(workDir, ".marvin", DIR);
}

function registryPath(workDir: string): string {
  return join(workDir, ".marvin", REGISTRY);
}

export function listWorktrees(workDir: string): WorktreeRecord[] {
  const p = registryPath(workDir);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as { worktrees?: WorktreeRecord[] };
    return Array.isArray(parsed.worktrees) ? parsed.worktrees : [];
  } catch {
    return [];
  }
}

function saveWorktrees(workDir: string, records: WorktreeRecord[]): void {
  mkdirSync(join(workDir, ".marvin"), { recursive: true });
  writeFileSync(registryPath(workDir), `${JSON.stringify({ worktrees: records }, null, 2)}\n`, "utf-8");
}

/** `slugify` for branch + directory names: lowercase, `-` separated, bounded. */
export function worktreeSlug(task: string): string {
  const s = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "task";
}

function git(workDir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: workDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Add patterns to the repository's `info/exclude` — git's per-clone ignore
 * file, which lives in the COMMON git dir and so applies to every worktree of
 * the clone at once. Never edits the project's `.gitignore`. Best-effort: a
 * noisy `git status` is not worth failing the caller.
 */
export function excludeFromStatus(workDir: string, patterns: string[]): void {
  try {
    const gitDir = git(workDir, ["rev-parse", "--git-common-dir"]);
    const exclude = join(isAbsolute(gitDir) ? gitDir : join(workDir, gitDir), "info", "exclude");
    const existing = existsSync(exclude) ? readFileSync(exclude, "utf-8") : "";
    const have = new Set(existing.split("\n"));
    const missing = patterns.filter((p) => !have.has(p));
    if (missing.length === 0) return;
    mkdirSync(join(exclude, ".."), { recursive: true });
    appendFileSync(exclude, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${missing.join("\n")}\n`);
  } catch {
    /* best-effort */
  }
}

/** Keep the nested checkouts out of `git status` without editing `.gitignore`. */
function excludeWorktreesDir(workDir: string): void {
  excludeFromStatus(workDir, [".marvin/worktrees/"]);
}

/**
 * The exclude pattern for a directory MARVIN SYMLINKS into a session worktree.
 *
 * A project ignores its dependency dirs as `node_modules/` — and the trailing
 * slash means "directories only", which a symlink is not. So the symlink
 * `prepareSessionWorktree` creates was untracked in every tab worktree, every
 * tab read as dirty, a close-with-merge always took the commit-first path,
 * and `git add -A` staged the symlink itself (observed 2026-09-10, six
 * worktrees on a real project). Anchored and without the slash, this matches
 * the symlink; in the main checkout the real directory was already ignored,
 * so the line changes nothing there.
 */
export function symlinkExcludePattern(rel: string): string {
  return `/${rel.replace(/^\/+|\/+$/g, "")}`;
}

/**
 * Create a worktree for one implementer task. Branches from the CURRENT
 * HEAD (not `origin/<default>`): the implementer must see the user's
 * unpushed work, and a fresh-from-origin tree is the SDK's default precisely
 * because it assumes a clean-slate side task — this is not that.
 */
export function createWorktree(workDir: string, task: string): WorktreeRecord {
  const existing = listWorktrees(workDir);
  const slug = uniqueSlug(workDir, worktreeSlug(task), existing);
  const path = join(worktreesDir(workDir), slug);
  const branch = `${BRANCH_PREFIX}${slug}`;
  return addWorktreeAtomically(workDir, { path, branch }, () => {
    const base = git(workDir, ["rev-parse", "HEAD"]);
    const baseRef = gitOr(workDir, ["symbolic-ref", "--short", "-q", "HEAD"], "");
    excludeWorktreesDir(workDir);
    const record: WorktreeRecord = {
      slug, path, branch, base, ...(baseRef ? { baseRef } : {}),
      createdAt: new Date().toISOString(), task, state: "running",
    };
    saveWorktrees(workDir, [...existing, record]);
    return record;
  });
}

/** ADR-0122 — below this much free space on the volume, no worktree is created. */
export const DEFAULT_MIN_FREE_GB = 10;
const GB = 1024 ** 3;

/**
 * The free-space floor in bytes. `MARVIN_WORKTREE_MIN_FREE_GB` (the user's own
 * environment) wins over the project's `minFreeGb`, which wins over the
 * default — a repository must not be able to override its owner.
 */
export function worktreeMinFreeBytes(projectGb?: number): number {
  const fromEnv = Number(process.env.MARVIN_WORKTREE_MIN_FREE_GB);
  const raw = process.env.MARVIN_WORKTREE_MIN_FREE_GB?.trim();
  if (raw && Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv * GB;
  if (typeof projectGb === "number" && Number.isFinite(projectGb) && projectGb >= 0) return projectGb * GB;
  return DEFAULT_MIN_FREE_GB * GB;
}

/** Free bytes available to an unprivileged writer on the volume holding `dir`. */
export function freeDiskBytes(dir: string): number {
  const st = statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
}

/** ADR-0122 — refuse to start a checkout on a nearly full disk. */
function assertDiskSpace(dir: string, minBytes: number): void {
  if (minBytes <= 0) return;
  let free: number;
  try {
    free = freeDiskBytes(dir);
  } catch {
    return; // an unreadable volume is git's problem to report, with a real error
  }
  if (free < minBytes) {
    throw new Error(
      `not enough free disk space for a worktree: ${(free / GB).toFixed(1)} GB free, at least ${(minBytes / GB).toFixed(1)} GB required ` +
        `(lower it with MARVIN_WORKTREE_MIN_FREE_GB, or "minFreeGb" in .marvin/worktree.json)`,
    );
  }
}

/** Sparse checkout needs per-worktree config, which git gained in 2.36. */
function assertSparseCapableGit(): void {
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf-8" }));
  const major = Number(m?.[1] ?? 0);
  const minor = Number(m?.[2] ?? 0);
  if (major < 2 || (major === 2 && minor < 36)) {
    throw new Error(`"sparseExclude" needs git 2.36 or newer (this is ${m?.[0] ?? "unknown"})`);
  }
}

/**
 * ADR-0122 — undo a half-made worktree, tolerating every step: the checkout
 * (git's view, then the directory), the admin entry, then the branch (which
 * cannot be deleted while a checkout holds it, so it goes last).
 */
function rollbackWorktreeAdd(workDir: string, path: string, branch: string, existed: { path: boolean; branch: boolean }): void {
  // Undo only what this attempt made: a checkout directory or a branch that was
  // already there before it is somebody else's.
  if (!existed.path) {
    gitOk(workDir, ["worktree", "remove", "--force", path]);
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  gitOk(workDir, ["worktree", "prune"]);
  if (!existed.branch) gitOk(workDir, ["branch", "-D", branch]);
}

/**
 * ADR-0122 — `git worktree add` as ONE operation: disk preflight, the add, the
 * optional sparse checkout, and whatever `finish` does (the registry write). If
 * any step throws, everything made so far is removed and the error propagates —
 * the caller refuses the tab, it never runs it somewhere else. A disk that
 * fills mid-add leaves nothing behind to be reconciled as an orphan.
 */
function addWorktreeAtomically(
  workDir: string,
  spec: { path: string; branch: string; minFreeBytes?: number | undefined; sparseExclude?: readonly string[] | undefined },
  finish: () => WorktreeRecord,
): WorktreeRecord {
  const sparse = spec.sparseExclude ?? [];
  mkdirSync(worktreesDir(workDir), { recursive: true });
  assertDiskSpace(worktreesDir(workDir), spec.minFreeBytes ?? worktreeMinFreeBytes());
  if (sparse.length > 0) assertSparseCapableGit();
  const existed = { path: existsSync(spec.path), branch: gitOk(workDir, ["show-ref", "--verify", "--quiet", `refs/heads/${spec.branch}`]) };
  try {
    git(workDir, ["worktree", "add", "-q", ...(sparse.length > 0 ? ["--no-checkout"] : []), "-b", spec.branch, spec.path, "HEAD"]);
    if (sparse.length > 0) {
      // Non-cone: cone mode can only say what to INCLUDE, and the point is
      // "everything except". Every entry was allowlisted at the read boundary
      // and is anchored with a leading `/`, so none can parse as an option or
      // a negation of something else.
      git(spec.path, ["sparse-checkout", "set", "--no-cone", "--", "/*", ...sparse.map((p) => `!/${p}/`)]);
      git(spec.path, ["checkout", "-q", spec.branch]);
    }
    return finish();
  } catch (err) {
    rollbackWorktreeAdd(workDir, spec.path, spec.branch, existed);
    throw err;
  }
}

/**
 * ADR-0107 — create the worktree a chat tab runs in. Same git path as an
 * implementer's (cut from the CURRENT HEAD, so the tab sees the user's
 * unpushed work), its own prefixes, and a record bound to the session. State
 * is `session` for as long as the tab is open; the lifecycle derivation below
 * never sweeps that state.
 */
export function createSessionWorktree(
  workDir: string,
  input: {
    sessionId: string;
    title?: string | undefined;
    replace?: boolean | undefined;
    /** ADR-0122 — free-space floor in bytes; defaults to `worktreeMinFreeBytes()`. */
    minFreeBytes?: number | undefined;
    /** ADR-0122 — validated project-relative directories left out of the checkout. */
    sparseExclude?: readonly string[] | undefined;
  },
): WorktreeRecord {
  let existing = listWorktrees(workDir);
  const already = existing.find((w) => w.kind === "session" && w.sessionId === input.sessionId);
  if (already && !input.replace) return already;
  const base = worktreeSlug(input.title?.trim() || input.sessionId.slice(0, 8));
  const slug = uniqueSlug(workDir, base, existing, SESSION_BRANCH_PREFIX);
  const path = join(worktreesDir(workDir), `${SESSION_DIR_PREFIX}${slug}`);
  const branch = `${SESSION_BRANCH_PREFIX}${slug}`;
  return addWorktreeAtomically(workDir, { path, branch, minFreeBytes: input.minFreeBytes, sparseExclude: input.sparseExclude }, () => {
    if (already) {
      // ADR-0111 — reopening a tab whose branch was already integrated cuts a
      // FRESH tree from the current HEAD; the old record loses its session
      // binding, stays closed, derives `merged`, and the sweep reclaims it.
      // Detached only once the new tree exists (ADR-0122): a refused recut
      // must leave the old record exactly as it was.
      const { sessionId: _drop, ...detached } = already;
      existing = existing.map((w) => (w.slug === already.slug ? { ...detached, finishedAt: already.finishedAt ?? new Date().toISOString() } : w));
    }
    const baseCommit = git(workDir, ["rev-parse", "HEAD"]);
    const baseRef = gitOr(workDir, ["symbolic-ref", "--short", "-q", "HEAD"], "");
    excludeWorktreesDir(workDir);
    const record: WorktreeRecord = {
      slug,
      path,
      branch,
      base: baseCommit,
      ...(baseRef ? { baseRef } : {}),
      createdAt: new Date().toISOString(),
      task: input.title?.trim() || `chat tab ${input.sessionId.slice(0, 8)}`,
      kind: "session",
      sessionId: input.sessionId,
      state: "session",
    };
    saveWorktrees(workDir, [...existing, record]);
    return record;
  });
}

/**
 * ADR-0122 — take back a session tree that was created a moment ago and never
 * ran a turn (its setup failed): checkout, branch and registry record. Unlike
 * `discardWorktree` it needs no closed tab, because there was never one.
 */
export function discardFreshSessionWorktree(workDir: string, rec: WorktreeRecord): void {
  rollbackWorktreeAdd(workDir, rec.path, rec.branch, { path: false, branch: false });
  try {
    saveWorktrees(workDir, listWorktrees(workDir).filter((w) => w.slug !== rec.slug));
  } catch {
    /* the registry reconciles a record whose ref is gone */
  }
}

/** ADR-0107 — the tab closed: the tree becomes an ordinary deliverable
 *  (`ready` / `empty` / `merged` by derivation). Nothing is deleted. */
/**
 * ADR-0111 — a branch is named by its first commit, not its first message.
 * Before a commit exists the name is irrelevant (the branch will not
 * survive); on the first turn that ends with a commit, rename it from the
 * first commit's subject, once. The directory keeps its name — moving a
 * checkout under a live session is not worth what it saves — and the
 * record's `slug` with it; only `branch` changes.
 */
export function nameSessionBranchFromCommit(workDir: string, sessionId: string): { from: string; to: string } | null {
  const all = listWorktrees(workDir);
  const idx = all.findIndex((w) => w.kind === "session" && w.sessionId === sessionId);
  if (idx < 0) return null;
  const rec = all[idx] as WorktreeRecord;
  if (rec.named) return null;
  // Only the tab's OWN commits: `--first-parent` skips what a catch-up merge
  // of the base branch brought in (other sessions' work), `--no-merges` skips
  // the merge commit itself, and excluding the base branch's current tip
  // covers a catch-up that fast-forwarded (no merge commit to steer by).
  // Without this a tab was named after a sibling's commit (2026-09-28).
  const baseTip = rec.baseRef && gitOk(workDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${rec.baseRef}`]) ? [`^refs/heads/${rec.baseRef}`] : [];
  const own = gitOr(workDir, ["log", "--reverse", "--first-parent", "--no-merges", "--format=%s", rec.branch, `^${rec.base}`, ...baseTip], "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (own.length === 0) return null;
  const subject = own[0] ?? "";
  const mark = (branch: string) => {
    all[idx] = { ...rec, branch, named: true };
    saveWorktrees(workDir, all);
  };
  const wanted = worktreeSlug(subject);
  if (!subject || wanted === rec.slug || `${SESSION_BRANCH_PREFIX}${wanted}` === rec.branch) {
    mark(rec.branch);
    return null;
  }
  const others = all.filter((_, i) => i !== idx);
  const slug = uniqueSlug(workDir, wanted, others, SESSION_BRANCH_PREFIX);
  const to = `${SESSION_BRANCH_PREFIX}${slug}`;
  if (!gitOk(workDir, ["branch", "-m", rec.branch, to])) {
    mark(rec.branch);
    return null;
  }
  mark(to);
  return { from: rec.branch, to };
}

/**
 * ADR-0121 — what a session tree's OWN work touched: files in its own commits
 * (first-parent, no merges, not already on the base branch — the same "own"
 * as `nameSessionBranchFromCommit`) plus uncommitted changes, and the branch
 * it is on now. Best-effort: any git failure yields what it could read.
 */
export function sessionOwnChanges(tree: { path: string; base: string; baseRef?: string }): { files: string[]; branch: string } {
  const baseTip =
    tree.baseRef && gitOk(tree.path, ["rev-parse", "--verify", "--quiet", `refs/heads/${tree.baseRef}`])
      ? [`^refs/heads/${tree.baseRef}`]
      : [];
  const files = new Set<string>();
  const committed = gitOr(
    tree.path,
    ["log", "--first-parent", "--no-merges", "--name-only", "--format=", "HEAD", `^${tree.base}`, ...baseTip],
    "",
  );
  for (const l of committed.split("\n")) if (l.trim()) files.add(l.trim());
  const dirty = gitOr(tree.path, ["status", "--porcelain", "--untracked-files=all"], "");
  for (const l of dirty.split("\n")) {
    // `git()` trims the whole output, so the FIRST line may have lost its
    // leading status space — strip the XY column by shape, not by width.
    const f = l.replace(/^[ MADRCUT?!]{1,2}\s/, "").trim().split(" -> ").pop();
    if (f) files.add(f);
  }
  return { files: [...files].sort(), branch: gitOr(tree.path, ["rev-parse", "--abbrev-ref", "HEAD"], "") };
}

export function markSessionWorktreeClosed(workDir: string, sessionId: string, now = Date.now()): WorktreeRecord | null {
  const all = listWorktrees(workDir);
  const idx = all.findIndex((w) => w.kind === "session" && w.sessionId === sessionId);
  if (idx < 0) return null;
  const rec = all[idx] as WorktreeRecord;
  if (!rec.finishedAt) {
    all[idx] = { ...rec, finishedAt: new Date(now).toISOString() };
    saveWorktrees(workDir, all);
  }
  return all[idx] as WorktreeRecord;
}

/** ADR-0107 — a kept tab reopened: back to `session`, never swept. */
export function reopenSessionWorktree(workDir: string, sessionId: string): WorktreeRecord | null {
  const all = listWorktrees(workDir);
  const idx = all.findIndex((w) => w.kind === "session" && w.sessionId === sessionId);
  if (idx < 0) return null;
  const { finishedAt: _drop, ...rest } = all[idx] as WorktreeRecord;
  all[idx] = { ...rest, state: "session" };
  saveWorktrees(workDir, all);
  return all[idx] as WorktreeRecord;
}

/** ADR-0107 — the session tree bound to `sessionId`, if any. */
export function findSessionWorktree(workDir: string, sessionId: string): WorktreeRecord | null {
  return listWorktrees(workDir).find((w) => w.kind === "session" && w.sessionId === sessionId) ?? null;
}

/**
 * ADR-0107 — an explicit user decision to throw a closed tab's tree away:
 * checkout AND branch, whatever they hold. Only for a `session` tree that has
 * been closed; an open tab's tree and every implementer tree are refused.
 */
export function discardWorktree(workDir: string, slug: string): { ok: boolean; message: string } {
  const rec = listWorktrees(workDir).find((w) => w.slug === slug);
  if (!rec) return { ok: false, message: `No worktree named ${slug}.` };
  if (rec.kind !== "session") return { ok: false, message: `${slug} is an implementer worktree — use sweep or drop.` };
  if (!rec.finishedAt) return { ok: false, message: `${slug} belongs to an open tab — close the tab first.` };
  gitOk(workDir, ["worktree", "remove", "--force", rec.path]);
  gitOk(workDir, ["worktree", "prune"]);
  const deleted = gitOk(workDir, ["branch", "-D", rec.branch]);
  saveWorktrees(workDir, listWorktrees(workDir).filter((w) => w.slug !== slug));
  return { ok: true, message: deleted ? `Discarded ${rec.branch} and its checkout.` : `Removed the checkout; branch ${rec.branch} could not be deleted.` };
}

/**
 * Remove a worktree checkout. The BRANCH is kept — it is the deliverable, and
 * deleting it is the user's decision after they have merged or rejected it.
 */
export interface RemoveOutcome {
  /** The record that was removed, or null when nothing was. */
  removed: WorktreeRecord | null;
  /** Set when removal was REFUSED rather than performed. */
  refused?: string;
}

/**
 * Remove a worktree checkout. The branch survives — deleting refs is
 * `sweepWorktrees`' job, and only under proof (ADR-0103).
 *
 * Refuses a `running` implementer unless forced. That rule existed as prose in
 * the tool description ("Never remove a worktree whose implementer is still
 * running") and as nothing else, which is the same prose-without-mechanism gap
 * ADR-0103 was written to close. On 2026-09-01 two live implementers had their
 * checkouts removed three minutes after dispatch; both branches ended with
 * zero commits.
 */
export function removeWorktree(workDir: string, slug: string, opts?: { force?: boolean }): RemoveOutcome {
  const existing = listWorktrees(workDir);
  const record = existing.find((w) => w.slug === slug);
  if (!record) return { removed: null };
  if (!opts?.force) {
    const state = runSync(reconcileOne(workDir, record, checkoutPaths(workDir))).state;
    if (state === "session") {
      return {
        removed: null,
        refused: `${slug} is the checkout of an open chat tab — close the tab first, or pass force.`,
      };
    }
    if (state === "running") {
      return {
        removed: null,
        refused:
          `${slug} is still being built by its implementer — removing its checkout now would ` +
          `discard work in progress. Wait for it to report, or pass force to remove it anyway.`,
      };
    }
  }
  // Already gone on disk → still drop the registry entry.
  removeCheckout(workDir, record.path);
  saveWorktrees(
    workDir,
    existing.filter((w) => w.slug !== slug),
  );
  return { removed: record };
}

/** Summary an implementer can be briefed with and the user can review from. */
export function describeWorktree(workDir: string, record: WorktreeRecord): string {
  const w = runSync(reconcileOne(workDir, record, checkoutPaths(workDir)));
  const where = w.state === "merged" && w.mergedInto ? ` into ${w.mergedInto}` : "";
  const dirty = w.dirty ? ", dirty" : "";
  const tab = w.kind === "session" ? " (chat tab)" : "";
  return (
    `${w.slug}${tab} [${w.state}${where}${dirty}]: ${w.branch} — ` +
    `${w.commits} commit(s), ${w.filesChanged} file(s) vs ${w.base.slice(0, 7)} — ${w.task}`
  );
}

// ── Lifecycle: derive from git, never only from the registry (ADR-0103) ───

/**
 * How long a record with no `finishedAt` is believed to still be running.
 *
 * `task_notification` is what normally ends the `running` state. If MARVIN is
 * killed mid-implementer that message never arrives, and without a fallback
 * the record would claim "running" forever and never be swept. Age is the only
 * signal available — the same reasoning behind Anthropic's `cleanupPeriodDays`.
 */
const RUNNING_STALE_MS = Number(process.env.MARVIN_WORKTREE_RUNNING_STALE_HOURS ?? 24) * 3_600_000;

/**
 * Resolve symlinks before comparing paths.
 *
 * `git worktree list` reports the REAL path. On macOS `/var` is a symlink to
 * `/private/var`, and a project reached through any symlinked parent hits the
 * same thing — the registry path and git's path then never compare equal, the
 * checkout reads as already gone, and the sweep silently reclaims nothing.
 */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function gitOk(workDir: string, args: string[]): boolean {
  try {
    git(workDir, args);
    return true;
  } catch {
    return false;
  }
}

function gitOr(workDir: string, args: string[], fallback: string): string {
  try {
    return git(workDir, args);
  } catch {
    return fallback;
  }
}

/**
 * The reconcile reads git dozens of times per call — ~150–200 spawns on a
 * project with 24 worktrees. Run with `execFileSync` on a request path, that
 * froze the whole sidecar for seconds at a time: a CPU profile on 2026-09-30
 * put 4.9 s of every 25 s inside `/api/sessions/watch`, and every other
 * request (backlog, git status, health) queued behind it.
 *
 * So the derivation is written ONCE, as a generator that yields each git read
 * it needs, and driven two ways: `runSync` for the rare mutation paths and the
 * tests, `runAsync` for every read path, which then never blocks the loop.
 * One implementation means the two can never disagree about a state.
 */
type GitRead = { cwd: string; args: string[]; fallback: string; ok?: true };
type GitSteps<T> = Generator<GitRead, T, string>;

function* gOr(cwd: string, args: string[], fallback: string): GitSteps<string> {
  return yield { cwd, args, fallback };
}

function* gOk(cwd: string, args: string[]): GitSteps<boolean> {
  return (yield { cwd, args, fallback: "", ok: true }) === "1";
}

function runSync<T>(steps: GitSteps<T>): T {
  let next = steps.next();
  while (!next.done) {
    const r = next.value;
    next = steps.next(r.ok ? (gitOk(r.cwd, r.args) ? "1" : "") : gitOr(r.cwd, r.args, r.fallback));
  }
  return next.value;
}

async function runAsync<T>(steps: GitSteps<T>): Promise<T> {
  let next = steps.next();
  while (!next.done) {
    const r = next.value;
    let out: string;
    try {
      const { stdout } = await execFileAsync("git", r.args, { cwd: r.cwd, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
      out = r.ok ? "1" : stdout.trim();
    } catch {
      out = r.ok ? "" : r.fallback;
    }
    next = steps.next(out);
  }
  return next.value;
}

/** ADR-0107 — the registered record whose checkout is `path` (canonical
 *  compare, so `/var` vs `/private/var` never hides a match). */
export function findWorktreeByPath(workDir: string, path: string): WorktreeRecord | null {
  const target = canonical(path);
  return listWorktrees(workDir).find((w) => canonical(w.path) === target) ?? null;
}

/** ADR-0107 — canonical absolute paths git currently lists as worktrees of
 *  `workDir` (the main checkout included). */
export function listGitWorktreePaths(workDir: string): string[] {
  return [...checkoutPaths(workDir)];
}

/** Absolute paths git currently considers checked-out worktrees. */
function checkoutPaths(workDir: string): Set<string> {
  return runSync(checkoutPathsSteps(workDir));
}

function* checkoutPathsSteps(workDir: string): GitSteps<Set<string>> {
  const out = yield* gOr(workDir, ["worktree", "list", "--porcelain"], "");
  const paths = out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => canonical(l.slice("worktree ".length).trim()));
  return new Set(paths);
}

/**
 * Refs whose history already contains `branch`, excluding the branch itself
 * and its own remote-tracking copy (being pushed is not being merged).
 *
 * One `git branch --contains` call answers "has this been merged, and into
 * what" for every ref at once. That is what makes a merge performed outside
 * MARVIN — in a terminal, in another session, by hand — visible on the next
 * read, which is the whole point of deriving rather than recording.
 */
function* containingRefs(workDir: string, branch: string): GitSteps<string[]> {
  return (yield* gOr(workDir, ["branch", "--all", "--contains", branch, "--format=%(refname:short)"], ""))
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r && !r.startsWith("(") && r !== branch && !r.endsWith(`/${branch}`));
}

/**
 * Where `record.branch` has already been integrated, or undefined.
 *
 * Ancestry first (`containingRefs`). Then content, because a squash, rebase or
 * cherry-pick merge rewrites the commits: `--contains` never sees them, and
 * such a branch read `ready` forever and was never swept (2026-10-01: 2.2 GB
 * on agri-saas-platform). The proof is that merging the branch into the target
 * would change nothing — `merge-tree` yields the target's own tree. That is as
 * strong as ancestry for the question the sweep asks ("is any work lost if the
 * branch goes?"), and a partial cherry-pick or a conflict fails it. Only the
 * tree's base branch and the main checkout's branch are tried: they are where
 * MARVIN's branches land, and each try is one git call per unmerged tree.
 */
function* mergedIntoSteps(workDir: string, record: WorktreeRecord): GitSteps<string | undefined> {
  const byAncestry = (yield* containingRefs(workDir, record.branch))[0];
  if (byAncestry) return byAncestry;
  const head = yield* gOr(workDir, ["symbolic-ref", "--quiet", "--short", "HEAD"], "");
  const targets = [...new Set([record.baseRef, head])].filter((t): t is string => !!t && t !== record.branch);
  for (const target of targets) {
    const tree = yield* gOr(workDir, ["rev-parse", "--verify", "--quiet", `${target}^{tree}`], "");
    if (!tree) continue;
    // Exit 1 on conflict → the fallback "" → not merged.
    const merged = (yield* gOr(workDir, ["merge-tree", "--write-tree", target, record.branch], "")).split("\n")[0];
    if (merged === tree) return target;
  }
  return undefined;
}

/** A slug no existing record and no live branch is already using. */
function uniqueSlug(workDir: string, base: string, existing: readonly WorktreeRecord[], prefix = BRANCH_PREFIX): string {
  const taken = (s: string) =>
    existing.some((w) => w.slug === s) || gitOk(workDir, ["rev-parse", "--verify", "--quiet", `${prefix}${s}`]);
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Derive one record's live state from git. Pure w.r.t. the registry file. */
function* reconcileOne(workDir: string, record: WorktreeRecord, checkouts: Set<string>, now = Date.now()): GitSteps<ReconciledWorktree> {
  const checkoutPresent = checkouts.has(canonical(record.path));
  const dirty = checkoutPresent && (yield* gOr(record.path, ["status", "--porcelain"], "")) !== "";
  const commits = Number(yield* gOr(workDir, ["rev-list", "--count", `${record.base}..${record.branch}`], "0")) || 0;
  const filesChanged = commits === 0
    ? 0
    : (yield* gOr(workDir, ["diff", "--name-only", `${record.base}..${record.branch}`], "")).split("\n").filter(Boolean).length;

  let state: WorktreeState;
  // `running` requires a BOUND implementer. A worktree that was created but
  // never dispatched to is not running anything, and calling it `running`
  // would park it outside every surface and every sweep for the grace period.
  const startedAt = Date.parse(record.createdAt);
  const stillRunning =
    !!record.taskId && !record.finishedAt && Number.isFinite(startedAt) && now - startedAt < RUNNING_STALE_MS;
  // ADR-0107 — a session tree is `session` for as long as its tab is open. No
  // staleness timer: a tab's lifetime is the client's, not a clock's. Once
  // closed (finishedAt set) it derives like any other tree.
  const openSession = record.kind === "session" && !record.finishedAt;
  let mergedInto: string | undefined;
  if (openSession) {
    state = "session";
    // Still the tab's tree, never swept while it is open — but say it is
    // spent, so the tab can offer to close and reclaim it.
    if (commits > 0) mergedInto = yield* mergedIntoSteps(workDir, record);
  } else if (stillRunning) {
    state = "running";
  } else if (commits === 0) {
    state = "empty";
  } else {
    mergedInto = yield* mergedIntoSteps(workDir, record);
    state = mergedInto ? "merged" : "ready";
  }
  const lastCommitAt = yield* gOr(workDir, ["log", "-1", "--format=%cI", record.branch], "");
  // Line counts only where they inform a decision — a branch still waiting to
  // be integrated. Merged and empty trees are not worth a numstat each on a
  // reconcile that already runs several git calls per tree.
  let added: number | undefined;
  let removed: number | undefined;
  if (commits > 0 && (state === "ready" || state === "session")) {
    added = 0;
    removed = 0;
    for (const line of (yield* gOr(workDir, ["diff", "--numstat", `${record.base}..${record.branch}`], "")).split("\n")) {
      const [a, r] = line.split("\t");
      added += Number(a) || 0;
      removed += Number(r) || 0;
    }
  }
  return {
    ...record,
    state,
    commits,
    filesChanged,
    dirty,
    checkoutPresent,
    ...(mergedInto ? { mergedInto } : {}),
    ...(lastCommitAt ? { lastCommitAt } : {}),
    ...(added !== undefined && removed !== undefined ? { added, removed } : {}),
  };
}

/**
 * Adopt `marvin/*` branches git knows about that the registry does not.
 *
 * `removeWorktree` prunes the registry entry but keeps the branch, so every
 * removal used to make its branch permanently invisible to `worktree_list` —
 * two such orphans were found on a real project, both with zero commits, both
 * unreachable through any MARVIN surface. Adoption closes that hole.
 */
function* adoptOrphans(workDir: string, known: readonly WorktreeRecord[], checkouts: Set<string>): GitSteps<WorktreeRecord[]> {
  const knownBranches = new Set(known.map((w) => w.branch));
  const branches = (yield* gOr(workDir, ["branch", "--list", `${BRANCH_PREFIX}*`, "--format=%(refname:short)"], ""))
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b && !knownBranches.has(b));
  const adopted: WorktreeRecord[] = [];
  for (const branch of branches) {
    // ADR-0107 — a lost SESSION record is classified from its ref name and
    // adopted as an open-tab tree: state `session`, never swept. The user
    // reclaims it from the UI once they know it exists.
    const isSession = branch.startsWith(SESSION_BRANCH_PREFIX);
    const slug = isSession ? branch.slice(SESSION_BRANCH_PREFIX.length) : branch.slice(BRANCH_PREFIX.length);
    const guessed = join(worktreesDir(workDir), isSession ? `${SESSION_DIR_PREFIX}${slug}` : slug);
    const path = checkouts.has(canonical(guessed))
      ? guessed
      : [...checkouts].find((c) => c.endsWith(`/${isSession ? `${SESSION_DIR_PREFIX}${slug}` : slug}`)) ?? guessed;
    const tip = yield* gOr(workDir, ["rev-parse", branch], "");
    adopted.push({
      slug,
      path,
      branch,
      base: yield* gOr(workDir, ["merge-base", branch, "HEAD"], tip),
      createdAt: new Date(0).toISOString(),
      task: isSession ? "(adopted session worktree)" : "(adopted — branch found outside the registry)",
      ...(isSession ? { kind: "session" as const } : { finishedAt: new Date(0).toISOString() }),
    } satisfies WorktreeRecord);
  }
  // A checkout under `.marvin/worktrees/` on a branch MARVIN did not name — a
  // tab that switched branches before its record was lost. Without this it was
  // invisible to every surface and every sweep (2026-10-01: 481 MB). `marvin/*`
  // checkouts are left to the pass above, and to a create still in progress.
  const claimed = new Set([...known, ...adopted].map((w) => canonical(w.path)));
  const root = canonical(worktreesDir(workDir));
  for (const path of checkouts) {
    if (claimed.has(path) || !path.startsWith(`${root}/`)) continue;
    const branch = yield* checkedOutRef(path);
    if (!branch || branch.startsWith(BRANCH_PREFIX)) continue;
    adopted.push({
      slug: basename(path),
      path,
      branch,
      base: yield* gOr(workDir, ["merge-base", branch, "HEAD"], branch),
      createdAt: new Date(0).toISOString(),
      task: "(adopted — checkout found outside the registry)",
      finishedAt: new Date(0).toISOString(),
    } satisfies WorktreeRecord);
  }
  return adopted;
}

/** The branch a checkout is on, or its commit when HEAD is detached. */
function* checkedOutRef(path: string): GitSteps<string> {
  const ref = yield* gOr(path, ["rev-parse", "--abbrev-ref", "HEAD"], "");
  return ref === "HEAD" ? yield* gOr(path, ["rev-parse", "HEAD"], "") : ref;
}

/**
 * The registry as git actually sees it. Drops records whose branch is gone,
 * adopts branches the registry lost, and recomputes every state. Persists only
 * when something changed, so a read is cheap and idempotent.
 */
export function reconcileWorktrees(workDir: string, now = Date.now()): ReconciledWorktree[] {
  return runSync(reconcileSteps(workDir, now));
}

/**
 * One session's worktree, derived from git NOW — no memo anywhere. For
 * decisions that destroy work: a tab close picks "discard silently" when the
 * tree is empty, and a cached "empty" from before the agent's last commit
 * would throw that commit away.
 */
export async function reconcileSessionWorktreeAsync(workDir: string, sessionId: string, now = Date.now()): Promise<ReconciledWorktree | null> {
  const record = listWorktrees(workDir).find((w) => w.kind === "session" && w.sessionId === sessionId);
  if (!record) return null;
  return runAsync(
    (function* () {
      const checkouts = yield* checkoutPathsSteps(workDir);
      return yield* reconcileOne(workDir, record, checkouts, now);
    })(),
  );
}

/** `reconcileWorktrees` without blocking the event loop — for every read path. */
export function reconcileWorktreesAsync(workDir: string, now = Date.now()): Promise<ReconciledWorktree[]> {
  return runAsync(reconcileSteps(workDir, now));
}

function* reconcileSteps(workDir: string, now: number): GitSteps<ReconciledWorktree[]> {
  const stored = listWorktrees(workDir);
  const checkouts = yield* checkoutPathsSteps(workDir);
  const alive: WorktreeRecord[] = [];
  for (const w of stored) {
    if (yield* gOk(workDir, ["rev-parse", "--verify", "--quiet", w.branch])) {
      alive.push(w);
      continue;
    }
    // The branch is gone but the checkout is not: the tree was switched to
    // another branch. Follow it — dropping the record orphaned the checkout.
    if (!checkouts.has(canonical(w.path))) continue;
    const current = yield* checkedOutRef(w.path);
    if (current) alive.push({ ...w, branch: current });
  }
  const all = [...alive, ...(yield* adoptOrphans(workDir, alive, checkouts))];
  const reconciled: ReconciledWorktree[] = [];
  for (const w of all) reconciled.push(yield* reconcileOne(workDir, w, checkouts, now));

  const next: WorktreeRecord[] = reconciled.map((w) => ({
    slug: w.slug,
    path: w.path,
    branch: w.branch,
    base: w.base,
    ...(w.baseRef ? { baseRef: w.baseRef } : {}),
    createdAt: w.createdAt,
    task: w.task,
    ...(w.kind ? { kind: w.kind } : {}),
    ...(w.sessionId ? { sessionId: w.sessionId } : {}),
    ...(w.taskId ? { taskId: w.taskId } : {}),
    ...(w.finishedAt ? { finishedAt: w.finishedAt } : {}),
    state: w.state,
    ...(w.mergedInto ? { mergedInto: w.mergedInto } : {}),
  }));
  if (JSON.stringify(next) !== JSON.stringify(stored)) saveWorktrees(workDir, next);
  return reconciled;
}

/** Bind a dispatched implementer's `task_id` to the worktree named in its prompt. */
export function bindWorktreeTask(workDir: string, worktreePath: string, taskId: string): void {
  const all = listWorktrees(workDir);
  const target = canonical(worktreePath);
  let changed = false;
  const next = all.map((w) => {
    if (canonical(w.path) !== target || w.taskId === taskId) return w;
    changed = true;
    const { finishedAt: _drop, ...rest } = w;
    return { ...rest, taskId, state: "running" as const };
  });
  if (changed) saveWorktrees(workDir, next);
}

/** Mark the worktree owned by `taskId` finished. Returns it, reconciled. */
export function markWorktreeFinished(workDir: string, taskId: string, now = Date.now()): ReconciledWorktree | null {
  const all = listWorktrees(workDir);
  const idx = all.findIndex((w) => w.taskId === taskId);
  if (idx < 0) return null;
  const record = all[idx] as WorktreeRecord;
  if (!record.finishedAt) {
    all[idx] = { ...record, finishedAt: new Date(now).toISOString() };
    saveWorktrees(workDir, all);
  }
  return runSync(reconcileOne(workDir, all[idx] as WorktreeRecord, checkoutPaths(workDir), now));
}

export interface SweepOutcome {
  slug: string;
  branch: string;
  /** `leftover`: a directory under `.marvin/worktrees/` that is no checkout. */
  state: WorktreeState | "leftover";
  removedCheckout: boolean;
  deletedBranch: boolean;
  reason: string;
}

/**
 * Reclaim what is provably safe to reclaim.
 *
 * Anthropic's documented rule is "remove a subagent worktree that finished
 * without changes; keep anything holding changed files, untracked files or
 * unpushed commits". MARVIN's state derivation is strictly stronger than that
 * heuristic — it knows whether the commits are already in another ref — so
 * `merged` is reclaimed on the same footing as `empty`, and no age TTL is
 * needed to make either safe:
 *
 *   empty  + clean → nothing exists to lose (the branch has zero commits)
 *   merged + clean → the commits are in history; the ref is redundant
 *   ready          → NEVER touched. This is the deliverable.
 *   running        → NEVER touched. The implementer is still working.
 *   dirty          → NEVER touched, in any state. It holds uncommitted work.
 */
export function sweepWorktrees(
  workDir: string,
  now = Date.now(),
  opts: { isSessionBusy?: (sessionId: string) => boolean } = {},
): SweepOutcome[] {
  return sweepReconciled(workDir, reconcileWorktrees(workDir, now), opts);
}

/** `sweepWorktrees` whose reconcile does not block the event loop. The removals
 *  themselves stay synchronous: they are few, and each must finish before the
 *  registry is rewritten. */
export async function sweepWorktreesAsync(
  workDir: string,
  now = Date.now(),
  opts: { isSessionBusy?: (sessionId: string) => boolean } = {},
): Promise<SweepOutcome[]> {
  return sweepReconciled(workDir, await reconcileWorktreesAsync(workDir, now), opts);
}

function sweepReconciled(
  workDir: string,
  reconciled: ReconciledWorktree[],
  opts: { isSessionBusy?: (sessionId: string) => boolean },
): SweepOutcome[] {
  const out: SweepOutcome[] = [];
  for (const w of reconciled) {
    if (w.state === "running" || w.state === "session" || w.state === "ready") continue;
    // ADR-0111 — a closed tab can still have a turn in its tree (a Sync turn
    // dispatched through the resume path); never pull the floor from under it.
    if (w.kind === "session" && w.sessionId && opts.isSessionBusy?.(w.sessionId)) continue;
    if (w.dirty) {
      out.push({
        slug: w.slug,
        branch: w.branch,
        state: w.state,
        removedCheckout: false,
        deletedBranch: false,
        reason: "kept — the checkout holds uncommitted or untracked work",
      });
      continue;
    }
    const removedCheckout = w.checkoutPresent && removeCheckout(workDir, w.path);
    gitOk(workDir, ["worktree", "prune"]);
    // `-D`, but only after our own proof: zero commits, or contained in another
    // ref. Never reached for `ready`, which is the state that holds real work.
    // Never for a branch MARVIN did not name: a tab may have switched its tree
    // to one of the user's, and that ref is theirs to keep.
    const ours = w.branch.startsWith(BRANCH_PREFIX);
    const deletedBranch = ours && gitOk(workDir, ["branch", "-D", w.branch]);
    if (deletedBranch || (!ours && (removedCheckout || !w.checkoutPresent))) {
      saveWorktrees(
        workDir,
        listWorktrees(workDir).filter((r) => r.branch !== w.branch && canonical(r.path) !== canonical(w.path)),
      );
    }
    const what = w.state === "empty" ? "branch had no commits" : `already merged into ${w.mergedInto ?? "another branch"}`;
    out.push({
      slug: w.slug,
      branch: w.branch,
      state: w.state,
      removedCheckout,
      deletedBranch,
      reason: ours ? `reclaimed — ${what}` : `checkout reclaimed — ${what}; branch ${w.branch} kept, MARVIN did not create it`,
    });
  }
  out.push(...sweepLeftoverDirs(workDir, reconciled));
  return out;
}

/**
 * `git worktree remove`, then make sure nothing is left on disk. A process
 * still writing into the tree — a graph refresh, a build started by the tab's
 * last turn — recreates files under it as git deletes them, and git removes
 * its registration anyway (2026-10-01: 960 MB of `graphify-out/` and Maven
 * `target/` in two directories nothing tracked any more).
 */
function removeCheckout(workDir: string, path: string): boolean {
  const removed = gitOk(workDir, ["worktree", "remove", "--force", path]);
  if (removed && existsSync(path)) rmSync(path, { recursive: true, force: true });
  return removed;
}

/**
 * Directories under `.marvin/worktrees/` that are no longer checkouts: what a
 * writer racing a removal leaves behind after `removeCheckout` has run. Only
 * MARVIN creates entries here, and a checkout always carries a `.git` file, so
 * a directory with neither a git registration nor a `.git` holds nothing but
 * regenerable output. An open tab's or running implementer's path is skipped
 * regardless — its checkout may be mid-creation.
 */
function sweepLeftoverDirs(workDir: string, reconciled: readonly ReconciledWorktree[]): SweepOutcome[] {
  const dir = worktreesDir(workDir);
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const checkouts = checkoutPaths(workDir);
  const held = new Set(
    reconciled.filter((w) => w.state === "session" || w.state === "running").map((w) => canonical(w.path)),
  );
  const out: SweepOutcome[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const real = canonical(path);
    if (checkouts.has(real) || held.has(real) || existsSync(join(path, ".git"))) continue;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      continue;
    }
    out.push({
      slug: name,
      branch: "",
      state: "leftover",
      removedCheckout: true,
      deletedBranch: false,
      reason: "reclaimed — leftover directory, no longer a git checkout",
    });
  }
  return out;
}

/**
 * Is there work in the main tree a merge would disturb?
 *
 * Two exclusions, and both are about not refusing a merge git itself would
 * happily perform.
 *
 * `.marvin/` — the registry file this module writes lives there, so a project
 * that does not gitignore `.marvin/` would read as dirty forever and every
 * merge would refuse. MARVIN's own bookkeeping is not the user's work.
 *
 * **Untracked files** — added 2026-09-10 after a user clicked "Merge into my
 * branch" and nothing happened. The refusal was correct by this function's old
 * rule and wrong by git's: their tree held three untracked files (`AGENTS.md`
 * and two spec files) that no merge would have touched. `git merge` does not
 * refuse because untracked files exist; it refuses only when the merge would
 * OVERWRITE one, and it says exactly which. `mergeWorktree` already aborts
 * cleanly and reports that message, so the stricter pre-check bought nothing
 * and made merge-on-close impossible for anyone with a stray file lying
 * around — which, on a repository an agent has been working in, is everyone.
 *
 * A tracked file that is modified, staged, deleted or in conflict still counts:
 * that is work a merge can genuinely disturb.
 */
/**
 * Tracked, modified paths in the main checkout outside `.marvin/` — the only
 * files a merge could clobber. Untracked files are not in a merge's way, and
 * `.marvin/*` is MARVIN's own bookkeeping, dirty on every real project.
 */
function dirtyTrackedPaths(workDir: string): string[] {
  // NOT `gitOr`: that trims the whole output, and `git status --porcelain` is
  // column-oriented — an unstaged change starts with a SPACE (" M path"), so
  // trimming eats the first line's first column and shifts its path by one
  // character. It showed up as a merge refused over "EADME.md", and as
  // `.marvin/` bookkeeping read as "marvin/…", which does not match the
  // `.marvin/` carve-out and so counted as a real blocker (2026-09-11).
  return gitRawLines(workDir, ["status", "--porcelain", "--untracked-files=no"])
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .map((p) => (p.includes(" -> ") ? p.slice(p.lastIndexOf(" -> ") + 4) : p))
    .filter((p) => !p.startsWith(".marvin/"));
}

/**
 * Lines of a git command's output, untrimmed. For column-oriented output
 * (`status --porcelain`), trimming is not cosmetic: it changes what the
 * columns mean.
 */
function gitRawLines(workDir: string, args: string[]): string[] {
  try {
    return execFileSync("git", args, { cwd: workDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n")
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/** Files `branch` changes since it diverged from HEAD (`HEAD...branch`). */
function branchChangedPaths(workDir: string, branch: string): string[] {
  return gitOr(workDir, ["diff", "--name-only", `HEAD...${branch}`], "").split("\n").filter(Boolean);
}

/**
 * The dirty tracked files a merge of `branch` would overwrite — git's own
 * refusal rule ("Your local changes to the following files would be
 * overwritten by merge"), applied BEFORE the merge so nothing is half-done.
 *
 * This used to be "any tracked file modified, anywhere": on 2026-09-11 a tab
 * that touched nine billing files could not close with *Merge* because two
 * ADRs another tab was writing were unsaved in the main checkout. Git would
 * have merged that without a word — the two sets of paths were disjoint. An
 * unrelated edit on main is not a reason to refuse; an overlapping one is.
 */
export function mergeBlockingPaths(workDir: string, branch: string): string[] {
  const dirty = new Set(dirtyTrackedPaths(workDir));
  if (dirty.size === 0) return [];
  return branchChangedPaths(workDir, branch).filter((p) => dirty.has(p));
}

function describeBlockingPaths(paths: string[]): string {
  const shown = paths.slice(0, 4).join(", ");
  const more = paths.length > 4 ? ` and ${paths.length - 4} more` : "";
  return `${shown}${more}`;
}

const execFileAsync = promisify(execFile);

/**
 * Take MARVIN's own symlinks back out of a worktree's index. Before the
 * exclude line existed, a close-with-merge ran `git add -A` and staged every
 * `symlinkDirectories` link; the commit then failed, and the links stayed
 * staged in the tree for the next attempt to find. Harmless when nothing is
 * staged: `git reset -- <path>` on an absent path exits 0.
 */
export function unstageSymlinkedDirs(worktreePath: string, dirs: string[]): void {
  if (dirs.length === 0) return;
  gitOk(worktreePath, ["reset", "-q", "--", ...dirs]);
}

/** Uncommitted or untracked work in a worktree, as `git status` sees it. */
export function worktreeHasWork(worktreePath: string): boolean {
  return gitOr(worktreePath, ["status", "--porcelain"], "") !== "";
}

export interface CommitOutcome {
  ok: boolean;
  message: string;
}

/** Ten minutes: the pre-commit hook this exists for compiles a Java service and runs its fast test band. */
const COMMIT_TIMEOUT_MS = 10 * 60_000;

/**
 * Commit everything in a session worktree as one work-in-progress commit, so
 * the branch can be merged on tab close.
 *
 * Asynchronous, deliberately. `git commit` runs the project's hooks, and a
 * real project's `pre-commit` compiled a service and ran its test band — well
 * past the 30 s the close route used to allow, which reported
 * `spawnSync git ETIMEDOUT` (2026-09-10). Worse than the failure was the wait:
 * that was `execFileSync` in a route handler, so for those 30 s Node's event
 * loop was held and every other request — the session feed, chat streaming —
 * queued behind a commit that was going to fail anyway. Hooks are the
 * project's policy and are honoured, not bypassed; what changes is that they
 * get the time they need and hold nothing else up while they run.
 */
export async function commitWorktreeWorkInProgress(
  worktreePath: string,
  slug: string,
  opts: { timeoutMs?: number } = {},
): Promise<CommitOutcome> {
  const timeout = opts.timeoutMs ?? COMMIT_TIMEOUT_MS;
  const run = (args: string[]) =>
    execFileAsync("git", args, { cwd: worktreePath, encoding: "utf-8", timeout, maxBuffer: 4 * 1024 * 1024 });
  try {
    await run(["add", "-A"]);
    await run(["commit", "-qm", `chore: work in progress from tab ${slug}`]);
    return { ok: true, message: `committed the worktree's uncommitted work on ${slug}` };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; killed?: boolean };
    if (e.killed || e.code === "ETIMEDOUT") {
      return {
        ok: false,
        message: `git commit did not finish within ${Math.round(timeout / 1000)} s — a commit hook is probably running long. Commit in the worktree yourself, then close the tab again.`,
      };
    }
    const detail = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim().split("\n").filter(Boolean).slice(-6).join("\n");
    return { ok: false, message: detail ? `git commit failed:\n${detail}` : `git commit failed: ${e.message}` };
  }
}

export interface MergeOutcome {
  ok: boolean;
  message: string;
  slug: string;
  branch: string;
}

/**
 * Merge one implementer branch into the CURRENT branch of the main tree.
 * Local only — never pushes, never opens an MR.
 *
 * Pushing each branch separately is what makes this expensive: on a
 * pipeline-gated project every merge to the default branch costs a full test
 * run. Implementer branches are cut from the current HEAD, so merging them
 * where the user already is means their commits ride along in whatever
 * pipeline that branch was going to run anyway — N branches, zero extra runs.
 */
/**
 * The merge commit's SUBJECT — deliberately byte-identical to what `git merge`
 * writes on its own.
 *
 * The first shape this had was `merge <branch>: <task>`, and it failed every
 * time it was used on a real project (2026-09-01: four merges, four
 * rejections). A `commit-msg` hook enforcing Conventional Commits refused it —
 * and refused it even though that same hook exempts merge commits, because the
 * exemption is written against git's own wording:
 *
 *     if echo "$SUBJECT" | grep -qE '^(Merge |fixup! |squash! |Revert ")'
 *
 * Every convention that exempts merges — commitlint's `defaultIgnores`
 * included — matches on that prefix. So the subject stays git's, and the task
 * description goes in the BODY, where no hook inspects it. This is also why
 * `--no-verify` is not the answer: the hook is not wrong, the message was.
 *
 * Subject length is bounded by construction: `worktreeSlug` caps the slug at
 * 40 characters, so this is at most 62 — inside the 72 that hooks commonly
 * enforce.
 */
function mergeSubject(branch: string): string {
  return `Merge branch '${branch}'`;
}

/**
 * The files git named as conflicted, from a failed merge's own output.
 *
 * What the panel used to show instead, in full (2026-09-11): *"Merge of
 * marvin/tab/feat-billing-… into main failed and was aborted: Command failed:
 * git merge --no-ff -m Merge branch 'marvin/tab/feat-billing…"* — the command
 * MARVIN ran, which the user did not type and cannot act on, in place of the
 * one fact that matters: which files clash. An error says what went wrong and
 * what to do about it.
 */
export function conflictedFiles(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split("\n")) {
    const m = /^CONFLICT \(.*?\): Merge conflict in (.+)$/.exec(line.trim())
      ?? /^CONFLICT \(.*?\): (?:.*? )?(?:in|of) (.+?) (?:deleted|renamed|added) /.exec(line.trim());
    if (m?.[1]) {
      const file = m[1].trim();
      if (file && !out.includes(file)) out.push(file);
    }
  }
  return out;
}

/** `a.ts, b.ts and 3 more` — a list a person reads, not a wall. */
export function describeConflicts(files: string[]): string {
  if (files.length === 0) return "";
  const shown = files.slice(0, 3).join(", ");
  return files.length > 3 ? `${shown} and ${files.length - 3} more` : shown;
}


/**
 * MARVIN's own bookkeeping under `.marvin/`: the runtime writes these to the
 * project root for every tab (ADR-0107), and they are tracked in git, so each
 * tab's branch also carries a copy it updates (a caveat marked met, a backlog
 * note). All of them are append-mostly Markdown. 2026-09-29: three merges in
 * one evening failed on them — twice on git's "local changes would be
 * overwritten" (the runtime's uncommitted append in the main checkout), once
 * on a textual conflict in the caveats log after that append was committed.
 */
const BOOKKEEPING_FILES = [".marvin/advisor-caveats.md", ".marvin/backlog.md", ".marvin/memory.md", ".marvin/session-notes.md"];
const BOOKKEEPING_DIRS = [".marvin/backlog/", ".marvin/memory/", ".marvin/security/"];

export function isMarvinBookkeeping(path: string): boolean {
  return BOOKKEEPING_FILES.includes(path) || BOOKKEEPING_DIRS.some((d) => path.startsWith(d));
}

/** A per-invocation attributes file that merges bookkeeping with git's union
 *  driver: both sides' lines are kept, so these files never conflict. The
 *  repository's own `.gitattributes` still wins where it says otherwise. */
function bookkeepingAttributesFile(): string {
  const path = join(tmpdir(), "marvin-bookkeeping.gitattributes");
  const body = [...BOOKKEEPING_FILES.map((f) => `/${f} merge=union`), ...BOOKKEEPING_DIRS.map((d) => `/${d}** merge=union`)].join("\n") + "\n";
  try {
    if (!existsSync(path) || readFileSync(path, "utf-8") !== body) writeFileSync(path, body);
  } catch {
    /* merging without it only brings back the old refusal */
  }
  return path;
}

interface SetAside {
  path: string;
  saved: string;
  base: string;
}

/** Uncommitted bookkeeping the merge would overwrite: remember it, restore the
 *  committed version so git can merge, and put it back afterwards. */
function setAsideBookkeeping(workDir: string, branch: string): SetAside[] {
  const dirty = new Set(
    gitRawLines(workDir, ["status", "--porcelain", "--untracked-files=no"])
      .map((l) => l.slice(3).replace(/^"|"$/g, ""))
      .filter(isMarvinBookkeeping),
  );
  if (dirty.size === 0) return [];
  const out: SetAside[] = [];
  for (const p of branchChangedPaths(workDir, branch).filter((x) => dirty.has(x))) {
    try {
      const saved = readFileSync(join(workDir, p), "utf-8");
      const base = gitOr(workDir, ["show", `HEAD:${p}`], "");
      git(workDir, ["checkout", "--", p]);
      out.push({ path: p, saved, base: base ? `${base}\n` : "" });
    } catch {
      /* leave it; git's own refusal will name it */
    }
  }
  return out;
}

/** Put set-aside bookkeeping back. After a merge, union it with what the
 *  merge produced; after a failed merge, restore it exactly. */
function restoreBookkeeping(workDir: string, items: SetAside[], merged: boolean): void {
  for (const it of items) {
    const target = join(workDir, it.path);
    try {
      if (!merged) {
        writeFileSync(target, it.saved);
        continue;
      }
      const dir = join(tmpdir(), `marvin-bk-${process.pid}-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const ours = join(dir, "ours");
      const base = join(dir, "base");
      const theirs = join(dir, "theirs");
      writeFileSync(ours, existsSync(target) ? readFileSync(target, "utf-8") : "");
      writeFileSync(base, it.base);
      writeFileSync(theirs, it.saved);
      const unioned = execFileSync("git", ["merge-file", "--union", "-p", ours, base, theirs], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      writeFileSync(target, unioned);
      rmSync(dir, { recursive: true, force: true });
    } catch {
      try {
        writeFileSync(target, it.saved);
      } catch {
        /* nothing more to do */
      }
    }
  }
}

export function mergeWorktree(
  workDir: string,
  slug: string,
  opts: { isSessionBusy?: (sessionId: string) => boolean } = {},
): MergeOutcome {
  // Reconcile only the branch being merged.
  //
  // This used to call `reconcileWorktrees` and pick one row out of the
  // result, which runs several git subprocesses PER worktree. Measured on a
  // real project with 12 of them: **1,159–1,221 ms**, against ~100 ms for the
  // one that matters. Every one of those is `execFileSync` inside a route
  // handler, so it is not merely slow — it holds Node's single event loop, and
  // the session feed, chat streaming and every other request queue behind it.
  // That is what "MARVIN becomes unresponsive when I merge" was.
  const stored = listWorktrees(workDir).find((r) => r.slug === slug);
  const w = stored ? runSync(reconcileOne(workDir, stored, checkoutPaths(workDir))) : undefined;
  if (!w) return { ok: false, message: `No worktree named ${slug}.`, slug, branch: "" };
  const fail = (message: string): MergeOutcome => ({ ok: false, message, slug, branch: w.branch });
  if (w.state === "running") return fail(`${w.branch} is still being built by its implementer.`);
  // ADR-0107 — an open tab's tree may be merged (the user is folding their
  // own work back), but never while that tab has a turn running.
  if (w.state === "session" && w.sessionId && opts.isSessionBusy?.(w.sessionId)) {
    return fail(`${w.branch} belongs to a chat tab with a turn in flight — wait for it or stop it first.`);
  }
  if (w.state === "empty") return fail(`${w.branch} has no commits to merge.`);
  if (w.state === "merged") return fail(`${w.branch} is already merged into ${w.mergedInto}.`);
  const blocking = mergeBlockingPaths(workDir, w.branch);
  if (blocking.length > 0) {
    return fail(
      `Uncommitted changes to ${describeBlockingPaths(blocking)} would be overwritten by ${w.branch} — commit or stash ${blocking.length === 1 ? "that file" : "those files"} before merging.`,
    );
  }
  const onto = gitOr(workDir, ["rev-parse", "--abbrev-ref", "HEAD"], "HEAD");
  const setAside = setAsideBookkeeping(workDir, w.branch);
  try {
    git(workDir, [
      "-c",
      `core.attributesFile=${bookkeepingAttributesFile()}`,
      "merge",
      "--no-ff",
      "-m",
      mergeSubject(w.branch),
      "-m",
      w.task,
      w.branch,
    ]);
    restoreBookkeeping(workDir, setAside, true);
  } catch (err) {
    gitOk(workDir, ["merge", "--abort"]);
    restoreBookkeeping(workDir, setAside, false);
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const files = conflictedFiles(`${e.stdout ?? ""}\n${e.stderr ?? ""}`);
    if (files.length > 0) {
      return fail(
        `${w.branch} conflicts with ${onto} in ${describeConflicts(files)}. Nothing changed — the merge was aborted. Sync that branch to resolve it in the tab that wrote it, then merge again.`,
      );
    }
    const detail = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim().split("\n").filter(Boolean).slice(-3).join("\n");
    return fail(`Merge of ${w.branch} into ${onto} failed and was aborted. ${detail || (err instanceof Error ? err.message : String(err))}`);
  }
  return {
    ok: true,
    message: `Merged ${w.branch} into ${onto} (${w.commits} commit(s), ${w.filesChanged} file(s)). Not pushed.`,
    slug,
    branch: w.branch,
  };
}

/** What one batch integration did. */
export interface MergeAllOutcome {
  merged: Array<{ slug: string; branch: string; message: string }>;
  /** The branch that stopped the run, and why. Absent when everything merged. */
  stopped?: { slug: string; branch: string; message: string };
  /** Branches not attempted, with the reason each was passed over. */
  skipped: Array<{ slug: string; branch: string; reason: string }>;
  message: string;
}

/**
 * Fold every finished branch into the current branch of the main tree, in one
 * pass, locally (ADR-0109).
 *
 * `mergeWorktree` integrates one branch, which was the whole surface until
 * every chat tab started producing one (ADR-0107). Five tabs meant five trips
 * through the same dialog, and the friction is what pushes people toward the
 * expensive path — one merge request per branch, which ADR-0103 measured at
 * ~10 pipeline-minutes to open and ~48 compute-minutes to merge, against an
 * allowance already exceeded. Batching is free: the branches are cut from this
 * checkout's HEAD, so their commits ride along in whatever run this branch was
 * already going to have.
 *
 * ## Only `ready` branches
 *
 * A `session` tree belongs to an OPEN chat tab. Folding one in behind the
 * user's back would merge work they may still be in the middle of, and the tab
 * already asks at close time — that dialog is where a live tab's branch gets
 * its decision, not here. `running` is an implementer mid-flight, `empty` has
 * nothing, `merged` is already in. So the set is exactly `ready`: finished
 * work, no tab holding it, not yet integrated. Everything else is reported as
 * skipped rather than silently ignored, because "it did nothing" and "there
 * was nothing to do" must not look the same.
 *
 * ## Stops at the first conflict
 *
 * `mergeWorktree` aborts a conflicting merge and leaves the branch untouched,
 * so a failure costs nothing. But continuing past one would leave the user
 * holding a half-integrated tree plus a conflict to resolve, with no obvious
 * order to resume in. Stopping means the tree is always "everything up to X is
 * in, X is what needs you".
 */
export function mergeAllWorktrees(
  workDir: string,
  opts: { isSessionBusy?: (sessionId: string) => boolean } = {},
): MergeAllOutcome {
  const all = reconcileWorktrees(workDir);
  const merged: MergeAllOutcome["merged"] = [];
  const skipped: MergeAllOutcome["skipped"] = [];

  for (const w of all) {
    if (w.state === "ready") continue;
    const reason =
      w.state === "session"
        ? "belongs to an open chat tab — close the tab to decide its branch"
        : w.state === "running"
          ? "still being built by its implementer"
          : w.state === "empty"
            ? "has no commits"
            : `already merged into ${w.mergedInto ?? "another branch"}`;
    skipped.push({ slug: w.slug, branch: w.branch, reason });
  }

  // Oldest first: the branches were cut in this order, so integrating them in
  // it is the order most likely to apply cleanly.
  const candidates = all
    .filter((w) => w.state === "ready")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (candidates.length === 0) {
    return { merged, skipped, message: "No finished branches to merge." };
  }
  // A run is registered so the panel can show what this is on — N merges of a
  // real branch is seconds each, but the surface must not go silent for them
  // either (ADR-0109 amendment, 2026-09-11).
  const job = startIntegrationJob(workDir, "merge-all", candidates.length);
  if (!job) {
    const running = getIntegrationJob(workDir);
    return {
      merged,
      skipped,
      message: `An integration is already running on this project (${running?.kind === "prepare-mr" ? "Prepare MR" : "Merge all"}). Wait for it to finish.`,
    };
  }
  // No up-front dirty-tree refusal: each merge checks the files IT would
  // overwrite (`mergeBlockingPaths`), so an unrelated edit on main stops
  // nothing and an overlapping one stops exactly the branch it overlaps.
  let stopped: MergeAllOutcome["stopped"];
  try {
    for (const w of candidates) {
      noteIntegrationProgress(workDir, { phase: "merging", current: w.branch, done: merged.length });
      const out = mergeWorktree(workDir, w.slug, opts);
      if (out.ok) {
        merged.push({ slug: out.slug, branch: out.branch, message: out.message });
        continue;
      }
      stopped = { slug: out.slug, branch: out.branch || w.branch, message: out.message };
      break;
    }
  } catch (err) {
    finishIntegrationJob(workDir, { ok: false, summary: `Merge all failed: ${err instanceof Error ? err.message : String(err)}` });
    throw err;
  }

  const onto = gitOr(workDir, ["rev-parse", "--abbrev-ref", "HEAD"], "HEAD");
  const head = merged.length === 0
    ? "Nothing merged."
    : `Merged ${merged.length} branch(es) into ${onto}. Not pushed — one push covers all of them.`;
  const message = stopped ? `${head} Stopped at ${stopped.branch}: ${stopped.message}` : head;
  finishIntegrationJob(workDir, { ok: !stopped, summary: message });
  return {
    merged,
    skipped,
    ...(stopped ? { stopped } : {}),
    message,
  };
}

// ── Containment (pure) ────────────────────────────────────────────────────

/** True when `target` is `worktree` itself or strictly inside it. */
export function isInsideWorktree(target: string, worktree: string): boolean {
  const rel = relative(resolve(worktree), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Absolute prefixes an implementer's shell may reference outside its tree. */
const SHELL_SAFE_ABSOLUTE = ["/usr/", "/opt/", "/bin/", "/sbin/", "/dev/null", "/etc/", "/private/tmp/", "/tmp/"];

export interface WorktreeGateDecision {
  decision: "allow" | "deny";
  reason: string;
  /** Rewritten input — set when a Bash command was pinned to the worktree. */
  updatedInput?: Record<string, unknown>;
}

/**
 * Gate decision for a tool call from an implementer bound to `worktree`.
 * Returns null for tools this policy does not govern (reads fall through to
 * the normal ladder).
 *
 * Bash is REWRITTEN, not just checked: `cd '<worktree>' && (<cmd>)`. The
 * subagent's process cwd is the main tree (the SDK ignores the dispatch
 * `cwd`), so without the prefix `npm test` would test the wrong checkout.
 * Prepending is deterministic; asking the model to remember is not.
 */
export function implementerWorktreePolicy(
  name: string,
  input: Record<string, unknown>,
  worktree: string,
  workDir: string,
): WorktreeGateDecision | null {
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
    const raw = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof raw !== "string" || raw.length === 0) {
      return { decision: "deny", reason: `${name} without a target path from an implementer — refused.` };
    }
    const target = isAbsolute(raw) ? raw : resolve(workDir, raw);
    if (isInsideWorktree(target, worktree)) {
      return { decision: "allow", reason: `Implementer write inside its worktree (${worktree}).` };
    }
    return {
      decision: "deny",
      reason:
        `${name} targets ${target}, which is OUTSIDE your worktree. You are an implementer ` +
        `bound to ${worktree} — every path you edit must be an ABSOLUTE path under it ` +
        `(relative paths resolve against the main tree, not your worktree). ADR-0081.`,
    };
  }
  if (name === "Bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    // The destructive / publish hard-deny floor applies to everyone.
    const base = toolPolicy("Bash", input);
    if (base.class === "deny") return { decision: "deny", reason: base.reason };
    if (/(^|[\s"'=:/])\.\.(\/|[\s"']|$)/.test(cmd)) {
      return { decision: "deny", reason: "Implementer shell may not use `..` — stay inside your worktree (ADR-0081)." };
    }
    const absolutes = [...cmd.matchAll(/(?:^|[\s"'=])((?:\/|~)[^\s"'|;&)]*)/g)].map((m) => m[1] ?? "");
    for (const a of absolutes) {
      if (a.startsWith("~")) {
        return { decision: "deny", reason: `Implementer shell may not reference ${a} — outside your worktree (ADR-0081).` };
      }
      if (isInsideWorktree(a, worktree)) continue;
      if (SHELL_SAFE_ABSOLUTE.some((p) => a === p || a.startsWith(p))) continue;
      return { decision: "deny", reason: `Implementer shell may not reference ${a} — outside your worktree (ADR-0081).` };
    }
    // Already pinned (e.g. our own rewrite echoed back) — leave it.
    const pinned = cmd.startsWith(`cd '${worktree}' && `);
    const rewritten = pinned ? cmd : `cd '${worktree}' && (${cmd})`;
    return {
      decision: "allow",
      reason: `Implementer shell pinned to its worktree (${worktree}).`,
      ...(pinned ? {} : { updatedInput: { ...input, command: rewritten } }),
    };
  }
  return null;
}

/**
 * ADR-0107 — main-loop containment for a chat session that runs in its own
 * worktree. Anthropic's harness enforces this only for worktrees the CLI
 * created; MARVIN created this one, so MARVIN checks:
 *
 *   - Edit/Write/NotebookEdit into the MAIN checkout → deny, naming the tab's
 *     tree and the way out (switch the tab to shared). Relative paths resolve
 *     against `worktree` — the SDK honours `cwd` for the main query — so an
 *     ordinary relative edit is allowed untouched.
 *   - Bash that names the main tree (`cd <root>`, `git -C <root>`,
 *     `--git-dir=<root>/.git`, `GIT_WORK_TREE=<root>`, or a bare absolute
 *     path under it that is not under `.marvin/worktrees/`) → CONFIRM, never a
 *     rewrite and never a silent deny: the main tree is the user's own checkout
 *     and a regex over a shell string will over-match.
 *   - everything else → null (the normal ladder).
 */
export function sessionWorktreePolicy(
  name: string,
  input: Record<string, unknown>,
  worktree: string,
  workDir: string,
): { decision: "allow" | "deny" | "confirm"; reason: string } | null {
  // ADR-0113 — the backlog copy under a worktree is a checkout of the cut
  // commit, never the live store (`<root>/.marvin/backlog`, which the
  // backlog tools read and write). A read of the copy answered "nothing
  // parked" while a sibling tab had parked the same defect a minute earlier.
  const backlogSnapshot = backlogSnapshotTarget(name, input, worktree, workDir);
  if (backlogSnapshot) {
    return {
      decision: "deny",
      reason:
        `${backlogSnapshot} is this tab's SNAPSHOT of the backlog, checked out when the branch was cut — not the live store. ` +
        `Use \`backlog_list\` / \`backlog_add\` / \`backlog_claim\` (they read and write the project's live backlog), ` +
        `or read the root copy by absolute path if you must. An item marked \`doing · tab: …\` is being worked by another tab.`,
    };
  }
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
    const raw = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof raw !== "string" || raw.length === 0) return null;
    const target = isAbsolute(raw) ? raw : resolve(worktree, raw);
    if (isInsideWorktree(target, worktree)) return null;
    if (isInsideWorktree(target, workDir)) {
      return {
        decision: "deny",
        reason:
          `${name} targets ${target}, which is the project's MAIN checkout. This tab is isolated in ` +
          `its own worktree at ${worktree}; edits belong there (relative paths already resolve into it). ` +
          `To edit the shared checkout, switch this tab to "shared" (ADR-0107).`,
      };
    }
    return null;
  }
  if (name === "Bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    if (!cmd) return null;
    const hit = mainTreeRedirect(cmd, workDir, worktree);
    if (!hit) return null;
    return {
      decision: "confirm",
      reason:
        `This command references the project's main checkout (${hit}) while this tab is isolated in ` +
        `${worktree}. Allow to run it against the shared checkout anyway, or deny and keep the work in the worktree.`,
    };
  }
  return null;
}

/**
 * The destination argument of a `cp`/`mv`/`rsync`-shaped command: whatever
 * `-t` / `--target-directory` names, else the last positional argument.
 * `null` when there is only one positional (nothing is being written).
 */
function destinationArg(argv: string[]): string | null {
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k] ?? "";
    if (a === "-t" || a === "--target-directory") return argv[k + 1] ?? null;
    const m = /^--target-directory=(.*)$/.exec(a);
    if (m) return m[1] ?? null;
  }
  const positional = argv.filter((a) => a.length > 0 && !a.startsWith("-"));
  return positional.length >= 2 ? (positional[positional.length - 1] ?? null) : null;
}

/** ADR-0113 — the path a tool call aims at the worktree's backlog copy, or null. */
function backlogSnapshotTarget(name: string, input: Record<string, unknown>, worktree: string, workDir: string): string | null {
  const snapshot = join(resolve(worktree), ".marvin", "backlog");
  const live = join(resolve(workDir), ".marvin", "backlog");
  const under = (p: string): boolean => {
    const abs = isAbsolute(p) ? resolve(p) : resolve(worktree, p);
    return abs === snapshot || abs === `${snapshot}.md` || abs.startsWith(`${snapshot}/`);
  };
  if (name === "Read" || name === "Grep" || name === "Glob") {
    const raw = (input.file_path ?? input.path) as unknown;
    if (typeof raw === "string" && raw && under(raw)) return raw;
    return null;
  }
  if (name === "Bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    if (!cmd.includes(".marvin/backlog")) return null;
    // Every mention must be the live store's absolute path to pass; a bare
    // `.marvin/backlog` in a worktree-cwd command is the snapshot.
    const mentions = [...cmd.matchAll(/(\S*\.marvin\/backlog[^\s"'|;&)]*)/g)].map((m) => m[1] ?? "");
    const bad = mentions.find((m) => !m.startsWith(live) && !isInsideWorktree(isAbsolute(m) ? m : resolve(worktree, m), live));
    return bad ?? null;
  }
  return null;
}

/**
 * The fragment of `cmd` that would WRITE INTO the main checkout, or null.
 *
 * Addendum 5: `cd <root>` used to confirm on its own, which put a prompt in
 * front of every read the model does in the shared checkout — graph queries
 * above all, since `graphify-out/` lives there and not in the worktree, and
 * the graphify-first rail makes them constant. A directory change is not a
 * write; what runs there decides. So the effective cwd is tracked across
 * `&&` / `;` / `|` segments, relative paths resolve against it, and a
 * confirm is raised only for a write-shaped command whose target lands in
 * the main tree: a redirection, a mutating shell tool, an in-place
 * `sed`/`perl`, a mutating git verb, a `cp`/`mv`-style DESTINATION, `dd`'s
 * `of=`, or a Python/Node file API opening for write. Reads fall through
 * wherever they run. `Edit`/`Write` into the main tree remain a hard deny,
 * so the model's normal way of changing a file is still contained.
 */
const MUTATING_GIT =
  /\bgit\b[^|;&]*?\s(?:add|rm|mv|checkout|restore|reset|commit|stash|apply|am|rebase|merge|cherry-pick|revert|clean|switch|branch|tag|worktree|push|pull|fetch|gc|prune)\b/;
const TARGET_ALL_TOOLS = /^(?:rm|rmdir|mkdir|touch|chmod|chown|chgrp|truncate|shred|unlink|mkfifo|tee|patch)$/;
const DEST_TOOLS = /^(?:cp|mv|ln|install|rsync|scp)$/;
const WRITE_API =
  /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|rename(?:Sync)?|unlink(?:Sync)?|rmSync|rmdir(?:Sync)?|mkdir(?:Sync)?|copyFile(?:Sync)?|truncate(?:Sync)?|shutil\.(?:copy\w*|move|rmtree)|os\.(?:remove|rename|unlink|makedirs|mkdir|rmdir)|write_text|write_bytes)\s*\(/;

export function mainTreeRedirect(cmd: string, workDir: string, worktree: string): string | null {
  const root = resolve(workDir);
  // `graphify-out/` is the project's knowledge graph — MARVIN-owned,
  // git-ignored, built per project at the root (ADR-0041) and read on
  // nearly every turn (Golden Rule 7). Graphify's own incremental-detect
  // snippet writes `.graphify_detect.json` there, so from a worktree tab
  // every graph query raised this confirm — in auto mode too, since
  // containment confirms in every mode. The graph is not the user's
  // checkout; a reach into it is not a reach into their work.
  const underRoot = (abs: string): boolean =>
    !isInsideWorktree(abs, worktree) &&
    !isInsideWorktree(abs, join(root, ".marvin", "worktrees")) &&
    !isInsideWorktree(abs, join(root, "graphify-out")) &&
    isInsideWorktree(abs, root);

  let cwd = worktree;
  for (const segment of cmd.split(/\n|;|&&|\|\||\|/)) {
    const seg = segment.trim();
    if (!seg) continue;
    const abs = (p: string): string => (isAbsolute(p) ? resolve(p) : resolve(cwd, p));

    // `cd <path>` moves everything after it; it writes nothing itself.
    const cd = /^cd\s+(?:-{1,2}\S+\s+)*(['"]?)([^'"]+)\1$/.exec(seg);
    if (cd) {
      const target = (cd[2] ?? "").trim();
      if (target && target !== "-") cwd = abs(target);
      continue;
    }

    const words = seg.split(/\s+/);
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "") || /^(?:sudo|env|nohup|time|command)$/.test(words[i] ?? ""))) i++;
    const tool = (words[i] ?? "").replace(/^.*\//, "");
    const argv = words.slice(i + 1).map((w) => w.replace(/^['"]|['"]$/g, ""));
    const positional = argv.filter((a) => a.length > 0 && !a.startsWith("-"));
    const inMainTree = underRoot(cwd);
    const firstUnderRoot = (list: string[]): string | null => list.find((p) => underRoot(abs(p))) ?? null;

    // Redirection into the main tree.
    const redir = /(?:^|[^>\d])>>?\s*(['"]?)([^\s'"|;&]+)\1/.exec(seg);
    if (redir?.[2] && underRoot(abs(redir[2]))) return redir[2];

    // git forced onto the main tree by flag, from anywhere.
    const forced =
      /git\s+-C\s+(['"]?)([^\s'"]+)\1/.exec(seg) ??
      /--git-dir=(['"]?)([^\s'"]+)\1/.exec(seg) ??
      /GIT_WORK_TREE=(['"]?)([^\s'"]+)\1/.exec(seg);
    if (forced?.[2] && underRoot(abs(forced[2].replace(/\/\.git$/, ""))) && MUTATING_GIT.test(seg)) return forced[0].trim();

    // Every path argument is a target.
    if (TARGET_ALL_TOOLS.test(tool)) {
      const hit = firstUnderRoot(positional);
      if (hit) return hit;
    }
    // Source → destination: only the destination writes.
    if (DEST_TOOLS.test(tool)) {
      const dest = destinationArg(argv);
      if (dest && underRoot(abs(dest))) return dest;
    }
    if (tool === "dd") {
      const of = /\bof=(['"]?)([^\s'"]+)\1/.exec(seg);
      if (of?.[2] && underRoot(abs(of[2]))) return of[2];
    }
    if (/^(?:sed|perl)$/.test(tool) && /(?:^|\s)-[a-zA-Z]*i/.test(seg)) {
      const hit = firstUnderRoot(positional);
      if (hit) return hit;
    }
    // A mutating git verb: in the main checkout by cwd, or naming it by path.
    if (tool === "git" && MUTATING_GIT.test(seg)) {
      if (inMainTree) return seg.length > 60 ? `${seg.slice(0, 57)}...` : seg;
      const hit = firstUnderRoot(positional);
      if (hit) return hit;
    }
    // Python / Node file APIs writing to a path in the main tree.
    // Single- and double-quoted runs are collected SEPARATELY: a shell
    // `node -e "…'/abs/path'…"` nests one inside the other, and one pass over
    // `['"]` pairs them off wrongly and loses the path.
    const quoted = [
      ...[...seg.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? ""),
      ...[...seg.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? ""),
    ];
    const openWrite = [...seg.matchAll(/open\(\s*['"]([^'"]+)['"]\s*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]/g)].map((m) => m[1] ?? "");
    const openHit = firstUnderRoot(openWrite);
    if (openHit) return openHit;
    if (WRITE_API.test(seg)) {
      const hit = firstUnderRoot(quoted);
      if (hit) return hit;
    }
  }
  return null;
}

// ── Prepare a merge request: squash chosen branches into one commit ────────

export interface PrepareMergeRequestInput {
  /** Lend the temporary worktree the preparation a tab's gets (symlinked
   *  dependency dirs, copied `.env`), so the project's commit hooks can run.
   *  Injected by the route to keep this module free of `worktree-setup`. */
  prepare?: (worktreePath: string) => void;
  /** Worktree slugs to fold in. Only `ready` ones are used; the rest are reported. */
  slugs: string[];
  /** Human name for the branch; slugged and dated. Defaults to the first task. */
  name?: string;
  /** Commit message (subject + body). Generated from the tasks when absent. */
  message?: string;
  /** Push the branch to the project's remote. Nothing leaves the machine otherwise. */
  push?: boolean;
  /** With `push`: open a merge request from the push (`-o merge_request.create`). */
  openMergeRequest?: boolean;
  /** MR target branch. Defaults to the current branch's upstream branch. */
  target?: string;
}

export interface PrepareMergeRequestOutcome {
  ok: boolean;
  branch: string;
  /** The squash commit, once made. */
  commit?: string;
  /** Message the commit was made with — the sheet shows it back. */
  message: string;
  merged: Array<{ slug: string; branch: string; message: string }>;
  stopped?: { slug: string; branch: string; message: string };
  skipped: Array<{ slug: string; branch: string; reason: string }>;
  pushed?: { remote: string; target: string; mergeRequest: boolean; url?: string; output: string };
  summary: string;
}

/** Branch prefix for integration branches. NOT under `marvin/`, or `adoptOrphans` would list it as a lost implementer tree. */
const MR_BRANCH_PREFIX = "mr/";
const PUSH_TIMEOUT_MS = 120_000;

/** The remote and branch the current branch tracks — where an MR is aimed. */
export function detectMergeTarget(workDir: string): { remote: string; target: string } | null {
  const upstream = gitOr(workDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], "");
  const slash = upstream.indexOf("/");
  if (slash > 0) return { remote: upstream.slice(0, slash), target: upstream.slice(slash + 1) };
  const remote = gitOr(workDir, ["remote"], "").split("\n").map((r) => r.trim()).find(Boolean);
  if (!remote) return null;
  const head = gitOr(workDir, ["symbolic-ref", "--short", "-q", `refs/remotes/${remote}/HEAD`], "");
  const target = head ? head.slice(remote.length + 1) : gitOr(workDir, ["rev-parse", "--abbrev-ref", "HEAD"], "main");
  return { remote, target };
}

/** Subject + body from the branches being folded. Conventional-Commits shaped so a `commit-msg` hook accepts it. */
export function mergeRequestMessage(rows: ReconciledWorktree[]): string {
  const subject = rows.length === 1
    ? `chore: integrate ${rows[0]?.task.slice(0, 50) ?? "one branch"}`
    : `chore: integrate ${rows.length} branches`;
  const body = rows
    .map((w) => `- ${w.branch}: ${w.task} (${w.commits} commit${w.commits === 1 ? "" : "s"}, ${w.filesChanged} file${w.filesChanged === 1 ? "" : "s"})`)
    .join("\n");
  return `${subject.slice(0, 72)}\n\n${body}\n`;
}

/**
 * Squash the chosen `ready` branches into ONE commit on a fresh `mr/…` branch,
 * then optionally push it and open a merge request from the push.
 *
 * Why a squash and not `mergeAllWorktrees` (ADR-0109): that folds each tab's
 * commits into the CURRENT branch as merge commits — right when the user's
 * branch is the integration point, wrong when the integration point is a
 * review on GitLab. A day of tabs is one piece of work to a reviewer; the
 * per-tab history stays on the tab branches, which this never touches.
 *
 * Why a temporary worktree: the squash writes into an index and a working
 * tree, and the user's checkout is dirty with MARVIN's own `.marvin/*` files
 * essentially always. A disposable checkout cut from HEAD means no stash, no
 * HEAD move under an open tab (ADR-0102), and a failure that costs nothing —
 * the tree is removed either way, the branch survives only if a commit landed.
 *
 * Oldest first, stop at the first conflict, report every skip with its
 * reason — the same rules as `mergeAllWorktrees`, for the same reasons.
 */
export async function prepareMergeRequest(
  workDir: string,
  input: PrepareMergeRequestInput,
): Promise<PrepareMergeRequestOutcome> {
  const started = Date.now();
  const job = startIntegrationJob(workDir, "prepare-mr", input.slugs.length);
  if (!job) {
    const running = getIntegrationJob(workDir);
    return {
      ok: false, branch: "", message: input.message ?? "", merged: [], skipped: [],
      summary: `An integration is already running on this project (${running?.kind === "merge-all" ? "Merge all" : "Prepare MR"}, started ${running?.startedAt ?? "just now"}). Wait for it to finish.`,
    };
  }
  let out: PrepareMergeRequestOutcome;
  try {
    out = await prepareMergeRequestInner(workDir, input);
  } catch (err) {
    // A throw here would leave the job running forever and lock the project
    // out of its own integration surface.
    const detail = err instanceof Error ? err.message : String(err);
    finishIntegrationJob(workDir, { ok: false, summary: `Prepare MR failed: ${detail}` });
    throw err;
  }
  finishIntegrationJob(workDir, { ok: out.ok, summary: out.summary, ...(out.branch ? { branch: out.branch } : {}) });
  // The squash commit can outlive the client's patience (hooks that compile
  // and test). The outcome must survive the client giving up: it goes to the
  // sidecar log, where "Prepare MR failed: the request timed out" can be
  // followed to what actually happened.
  console.warn(
    `[prepare-mr] ${out.ok ? "ok" : "failed"} after ${Math.round((Date.now() - started) / 1000)} s — ${out.branch || "(no branch)"}: ${out.summary.split("\n")[0]}`,
  );
  return out;
}

async function prepareMergeRequestInner(
  workDir: string,
  input: PrepareMergeRequestInput,
): Promise<PrepareMergeRequestOutcome> {
  const all = reconcileWorktrees(workDir);
  const merged: PrepareMergeRequestOutcome["merged"] = [];
  const skipped: PrepareMergeRequestOutcome["skipped"] = [];
  const wanted = new Set(input.slugs);
  const rows: ReconciledWorktree[] = [];
  for (const slug of wanted) {
    const w = all.find((r) => r.slug === slug);
    if (!w) {
      skipped.push({ slug, branch: "", reason: "no such worktree" });
      continue;
    }
    if (w.state === "ready") {
      rows.push(w);
      continue;
    }
    const reason =
      w.state === "session"
        ? "belongs to an open tab — close the tab (keeping the branch) to include it"
        : w.state === "running"
          ? "still being built by its implementer"
          : w.state === "empty"
            ? "has no commits"
            : `already merged into ${w.mergedInto ?? "another branch"}`;
    skipped.push({ slug: w.slug, branch: w.branch, reason });
  }
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Provisional until the loop below says what actually applied. A reviewer
  // reads this subject: on 2026-09-11 a run that stopped at a conflict after
  // ONE branch pushed a commit titled "chore: integrate 6 branches" holding
  // one branch's six files, and opened a merge request for it.
  let message = input.message?.trim() ? input.message : mergeRequestMessage(rows);
  const fail = (branch: string, summary: string): PrepareMergeRequestOutcome => ({
    ok: false, branch, message, merged, skipped, summary,
  });
  if (rows.length === 0) return fail("", "Nothing to integrate — no finished branch was selected.");

  const day = new Date().toISOString().slice(0, 10);
  // The sheet's placeholder reads `mr/<today>-<name>`, and people type the
  // whole thing: strip a leading `mr/` or `mr-` and a leading date so the
  // branch is `mr/2026-09-11-billing`, never `mr/2026-09-11-mr-2026-09-11`.
  const typed = (input.name?.trim() ?? "").replace(/^mr[\/-]/i, "").replace(/^\d{4}-\d{2}-\d{2}-?/, "");
  const baseName = worktreeSlug(typed || rows[0]?.task || "integration");
  let branch = `${MR_BRANCH_PREFIX}${day}-${baseName}`;
  for (let n = 2; gitOk(workDir, ["rev-parse", "--verify", "--quiet", branch]); n++) {
    branch = `${MR_BRANCH_PREFIX}${day}-${baseName}-${n}`;
  }
  noteIntegrationProgress(workDir, { phase: "preparing", branch, total: rows.length });
  const tmp = join(worktreesDir(workDir), `mr-${day}-${baseName}-${process.pid}`);
  mkdirSync(worktreesDir(workDir), { recursive: true });
  try {
    git(workDir, ["worktree", "add", "-q", "-b", branch, tmp, "HEAD"]);
  } catch (err) {
    return fail(branch, `Could not cut ${branch} from HEAD: ${err instanceof Error ? err.message : String(err)}`);
  }
  const base = git(workDir, ["rev-parse", "HEAD"]);
  const cleanup = () => {
    gitOk(workDir, ["worktree", "remove", "--force", tmp]);
    gitOk(workDir, ["worktree", "prune"]);
  };
  // The squash commit runs the project's hooks (that is the point of it —
  // a reviewer reads this commit), and a fresh checkout has no
  // `node_modules`, `target`, `.env`. The caller lends the same preparation a
  // tab's worktree gets; without it a pre-commit band that compiles fails on
  // a missing dependency and the refusal reads as a hook failure.
  try {
    input.prepare?.(tmp);
  } catch {
    // Preparation is best-effort: a hook may still pass without it.
  }

  // One temporary commit per branch, so a conflict on the third loses only the
  // third: `reset --hard` there drops the failed squash and keeps the two that
  // applied. The temporaries collapse into one commit below.
  let stopped: PrepareMergeRequestOutcome["stopped"];
  for (const w of rows) {
    noteIntegrationProgress(workDir, { phase: "squashing", current: w.branch, done: merged.length });
    try {
      git(tmp, ["merge", "--squash", "-q", w.branch]);
      git(tmp, ["commit", "-q", "--no-verify", "-m", `squash ${w.branch}`]);
      merged.push({ slug: w.slug, branch: w.branch, message: `${w.commits} commit(s), ${w.filesChanged} file(s)` });
    } catch (err) {
      gitOk(tmp, ["reset", "--hard", "HEAD"]);
      gitOk(tmp, ["clean", "-fdq"]);
      stopped = { slug: w.slug, branch: w.branch, message: `conflicts with what is already integrated: ${err instanceof Error ? err.message.split("\n").slice(-3).join(" ") : String(err)}` };
      break;
    }
  }
  if (merged.length === 0) {
    cleanup();
    gitOk(workDir, ["branch", "-D", branch]);
    return { ...fail(branch, `Nothing integrated. ${stopped ? `${stopped.branch} ${stopped.message}` : ""}`.trim()), ...(stopped ? { stopped } : {}) };
  }
  // The commit names what is IN it. The user's own wording is theirs and is
  // never rewritten; a generated one counts the branches that applied.
  if (!input.message?.trim()) {
    message = mergeRequestMessage(rows.filter((r) => merged.some((m) => m.slug === r.slug)));
  }

  // Collapse to the one commit, hooks honoured — this is the commit a
  // reviewer will read, so it must pass what the project enforces.
  let commit: string;
  noteIntegrationProgress(workDir, { phase: "committing", current: undefined, done: merged.length });
  try {
    git(tmp, ["reset", "--soft", base]);
    await execFileAsync("git", ["commit", "-q", "-m", message], {
      cwd: tmp, encoding: "utf-8", timeout: COMMIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    commit = git(tmp, ["rev-parse", "HEAD"]);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const detail = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim().split("\n").filter(Boolean).slice(-6).join("\n");
    cleanup();
    gitOk(workDir, ["branch", "-D", branch]);
    return { ...fail(branch, `The squash commit was refused${detail ? `:\n${detail}` : `: ${e.message}`}`), ...(stopped ? { stopped } : {}) };
  }
  cleanup();

  const folded = `Squashed ${merged.length} branch(es) into one commit on ${branch}.`;
  if (!input.push) {
    return {
      ok: true, branch, commit, message, merged, skipped, ...(stopped ? { stopped } : {}),
      summary: `${folded} Not pushed.${stopped ? ` Stopped at ${stopped.branch}: ${stopped.message}` : ""}`,
    };
  }

  // A partial integration is not what the push was asked for. Ticking six
  // branches and "open a merge request" means one request for six; pushing
  // one of them opens a request that misrepresents the day's work to a
  // reviewer and spends a pipeline on something that has to be redone once
  // the conflict is resolved (ADR-0109 — CI minutes are the scarce thing).
  // The branch is on disk either way, so nothing is lost by waiting.
  if (stopped) {
    return {
      ok: true, branch, commit, message, merged, skipped, stopped,
      summary: `${folded} Not pushed — it stopped at ${stopped.branch}: ${stopped.message}. Sync that branch and run Prepare MR again, or push ${branch} yourself if a partial integration is what you want.`,
    };
  }

  const aim = detectMergeTarget(workDir);
  if (!aim) {
    return { ok: true, branch, commit, message, merged, skipped, summary: `${folded} Not pushed: this repository has no remote.` };
  }
  const target = input.target?.trim() || aim.target;
  noteIntegrationProgress(workDir, { phase: "pushing", current: aim.remote, done: merged.length });
  const args = ["push", "-u", aim.remote, `${branch}:${branch}`];
  if (input.openMergeRequest) {
    const title = message.split("\n")[0] ?? branch;
    args.push("-o", "merge_request.create", "-o", `merge_request.target=${target}`, "-o", `merge_request.title=${title}`);
  }
  try {
    const out = await execFileAsync("git", args, {
      cwd: workDir, encoding: "utf-8", timeout: PUSH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const output = `${out.stdout ?? ""}${out.stderr ?? ""}`.trim();
    const url = /https?:\/\/\S+\/merge_requests\/\d+/.exec(output)?.[0];
    return {
      // Nothing is pushed after a conflict (above), so a push that happened
      // integrated every branch that was asked for.
      ok: true, branch, commit, message, merged, skipped,
      pushed: { remote: aim.remote, target, mergeRequest: !!input.openMergeRequest, ...(url ? { url } : {}), output },
      summary: `${folded} Pushed to ${aim.remote}.${input.openMergeRequest ? (url ? ` Merge request: ${url}` : " Merge request requested — see the push output.") : ""}`,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; killed?: boolean };
    const detail = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim().split("\n").filter(Boolean).slice(-6).join("\n");
    return {
      ok: false, branch, commit, message, merged, skipped,
      summary: `${folded} Push to ${aim.remote} failed${e.killed ? " (timed out)" : ""}${detail ? `:\n${detail}` : `: ${e.message}`}. The branch is on disk; push it yourself when the remote is reachable.`,
    };
  }
}

// ── Tab and implementer branches are integrated locally, never published alone ──

const PUBLISH_CMD = /\bgit\s+push\b/;
const OPEN_OR_MERGE_REQUEST = /\b(?:glab\s+mr\s+(?:create|new|merge)|gh\s+pr\s+(?:create|merge))\b|merge_request\.create/;
/** A `marvin/…` ref anywhere in the command: a tab or implementer branch by name. */
const MARVIN_REF = new RegExp(`(?:^|[\\s:'"=,])${BRANCH_PREFIX}[\\w./-]+`);

/**
 * ADR-0109, second amendment (2026-09-12) — MARVIN never publishes a tab or
 * implementer branch on its own. Two tabs each pushed their branch and asked
 * to open a merge request; both confirms were allowed and the project paid two
 * pipelines for work that Prepare MR folds into one. In a worktree tab the
 * right answer to "push this?" or "open an MR?" is always the same, so it is
 * a deny that names the local path, not a question.
 *
 *   - worktree tab: any `git push`, and any MR/PR create or merge → deny.
 *   - shared tab: a push or MR that names a `marvin/…` branch → deny. Pushing
 *     the user's own branch stays on the normal ladder (and MR creation on
 *     the metered-CI confirm).
 *   - subagents: not this rule's business — an implementer has ADR-0081.
 */
export function localOnlyIntegrationPolicy(
  name: string,
  input: Record<string, unknown>,
  sessionTree: { mode: "worktree"; branch: string } | { mode: "shared" } | undefined,
): { decision: "deny"; reason: string } | null {
  if (name !== "Bash") return null;
  const cmd = typeof input.command === "string" ? input.command : "";
  if (!cmd) return null;
  const publishes = PUBLISH_CMD.test(cmd);
  const requests = OPEN_OR_MERGE_REQUEST.test(cmd);
  if (!publishes && !requests) return null;
  const remedy =
    "Tab branches are integrated locally, never published one by one (ADR-0109): each branch pushed as its own " +
    "merge request costs a full pipeline. Close the tab with Merge, or use Source Control ▸ Worktrees ▸ Merge all / " +
    "Prepare MR — the user squashes the finished tabs into one commit and opens one request from there.";
  if (sessionTree?.mode === "worktree") {
    const act = requests ? "opening or merging a request from" : "pushing";
    return { decision: "deny", reason: `This tab runs on its own branch (${sessionTree.branch}); ${act} it is not MARVIN's to do. ${remedy}` };
  }
  if (MARVIN_REF.test(cmd)) {
    return { decision: "deny", reason: `This command publishes a MARVIN tab or implementer branch. ${remedy}` };
  }
  return null;
}
