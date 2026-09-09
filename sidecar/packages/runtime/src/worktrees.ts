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

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { toolPolicy } from "@marvin/tools/policy";

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

/** Keep the nested checkouts out of `git status` without editing `.gitignore`. */
function excludeWorktreesDir(workDir: string): void {
  try {
    const gitDir = git(workDir, ["rev-parse", "--git-common-dir"]);
    const exclude = join(isAbsolute(gitDir) ? gitDir : join(workDir, gitDir), "info", "exclude");
    const line = ".marvin/worktrees/";
    const existing = existsSync(exclude) ? readFileSync(exclude, "utf-8") : "";
    if (!existing.split("\n").includes(line)) {
      mkdirSync(join(exclude, ".."), { recursive: true });
      appendFileSync(exclude, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${line}\n`);
    }
  } catch {
    /* best-effort: a noisy `git status` is not worth failing the dispatch */
  }
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
  mkdirSync(worktreesDir(workDir), { recursive: true });
  git(workDir, ["worktree", "add", "-q", "-b", branch, path, "HEAD"]);
  const base = git(workDir, ["rev-parse", "HEAD"]);
  excludeWorktreesDir(workDir);
  const record: WorktreeRecord = { slug, path, branch, base, createdAt: new Date().toISOString(), task, state: "running" };
  saveWorktrees(workDir, [...existing, record]);
  return record;
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
  input: { sessionId: string; title?: string | undefined },
): WorktreeRecord {
  const existing = listWorktrees(workDir);
  const already = existing.find((w) => w.kind === "session" && w.sessionId === input.sessionId);
  if (already) return already;
  const base = worktreeSlug(input.title?.trim() || input.sessionId.slice(0, 8));
  const slug = uniqueSlug(workDir, base, existing, SESSION_BRANCH_PREFIX);
  const path = join(worktreesDir(workDir), `${SESSION_DIR_PREFIX}${slug}`);
  const branch = `${SESSION_BRANCH_PREFIX}${slug}`;
  mkdirSync(worktreesDir(workDir), { recursive: true });
  git(workDir, ["worktree", "add", "-q", "-b", branch, path, "HEAD"]);
  const baseCommit = git(workDir, ["rev-parse", "HEAD"]);
  excludeWorktreesDir(workDir);
  const record: WorktreeRecord = {
    slug,
    path,
    branch,
    base: baseCommit,
    createdAt: new Date().toISOString(),
    task: input.title?.trim() || `chat tab ${input.sessionId.slice(0, 8)}`,
    kind: "session",
    sessionId: input.sessionId,
    state: "session",
  };
  saveWorktrees(workDir, [...existing, record]);
  return record;
}

/** ADR-0107 — the tab closed: the tree becomes an ordinary deliverable
 *  (`ready` / `empty` / `merged` by derivation). Nothing is deleted. */
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
    const state = reconcileOne(workDir, record, checkoutPaths(workDir)).state;
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
  try {
    git(workDir, ["worktree", "remove", "--force", record.path]);
  } catch {
    /* already gone on disk — still drop the registry entry */
  }
  saveWorktrees(
    workDir,
    existing.filter((w) => w.slug !== slug),
  );
  return { removed: record };
}

/** Summary an implementer can be briefed with and the user can review from. */
export function describeWorktree(workDir: string, record: WorktreeRecord): string {
  const w = reconcileOne(workDir, record, checkoutPaths(workDir));
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
  const out = gitOr(workDir, ["worktree", "list", "--porcelain"], "");
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
function containingRefs(workDir: string, branch: string): string[] {
  return gitOr(workDir, ["branch", "--all", "--contains", branch, "--format=%(refname:short)"], "")
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r && !r.startsWith("(") && r !== branch && !r.endsWith(`/${branch}`));
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
function reconcileOne(workDir: string, record: WorktreeRecord, checkouts: Set<string>, now = Date.now()): ReconciledWorktree {
  const checkoutPresent = checkouts.has(canonical(record.path));
  const dirty = checkoutPresent && gitOr(record.path, ["status", "--porcelain"], "") !== "";
  const commits = Number(gitOr(workDir, ["rev-list", "--count", `${record.base}..${record.branch}`], "0")) || 0;
  const filesChanged = commits === 0
    ? 0
    : gitOr(workDir, ["diff", "--name-only", `${record.base}..${record.branch}`], "").split("\n").filter(Boolean).length;

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
  } else if (stillRunning) {
    state = "running";
  } else if (commits === 0) {
    state = "empty";
  } else {
    mergedInto = containingRefs(workDir, record.branch)[0];
    state = mergedInto ? "merged" : "ready";
  }
  return {
    ...record,
    state,
    commits,
    filesChanged,
    dirty,
    checkoutPresent,
    ...(mergedInto ? { mergedInto } : {}),
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
function adoptOrphans(workDir: string, known: readonly WorktreeRecord[], checkouts: Set<string>): WorktreeRecord[] {
  const knownBranches = new Set(known.map((w) => w.branch));
  const branches = gitOr(workDir, ["branch", "--list", `${BRANCH_PREFIX}*`, "--format=%(refname:short)"], "")
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b && !knownBranches.has(b));
  return branches.map((branch) => {
    // ADR-0107 — a lost SESSION record is classified from its ref name and
    // adopted as an open-tab tree: state `session`, never swept. The user
    // reclaims it from the UI once they know it exists.
    const isSession = branch.startsWith(SESSION_BRANCH_PREFIX);
    const slug = isSession ? branch.slice(SESSION_BRANCH_PREFIX.length) : branch.slice(BRANCH_PREFIX.length);
    const guessed = join(worktreesDir(workDir), isSession ? `${SESSION_DIR_PREFIX}${slug}` : slug);
    const path = checkouts.has(canonical(guessed))
      ? guessed
      : [...checkouts].find((c) => c.endsWith(`/${isSession ? `${SESSION_DIR_PREFIX}${slug}` : slug}`)) ?? guessed;
    return {
      slug,
      path,
      branch,
      base: gitOr(workDir, ["merge-base", branch, "HEAD"], gitOr(workDir, ["rev-parse", branch], "")),
      createdAt: new Date(0).toISOString(),
      task: isSession ? "(adopted session worktree)" : "(adopted — branch found outside the registry)",
      ...(isSession ? { kind: "session" as const } : { finishedAt: new Date(0).toISOString() }),
    } satisfies WorktreeRecord;
  });
}

/**
 * The registry as git actually sees it. Drops records whose branch is gone,
 * adopts branches the registry lost, and recomputes every state. Persists only
 * when something changed, so a read is cheap and idempotent.
 */
export function reconcileWorktrees(workDir: string, now = Date.now()): ReconciledWorktree[] {
  const stored = listWorktrees(workDir);
  const checkouts = checkoutPaths(workDir);
  const alive = stored.filter((w) => gitOk(workDir, ["rev-parse", "--verify", "--quiet", w.branch]));
  const all = [...alive, ...adoptOrphans(workDir, alive, checkouts)];
  const reconciled = all.map((w) => reconcileOne(workDir, w, checkouts, now));

  const next: WorktreeRecord[] = reconciled.map((w) => ({
    slug: w.slug,
    path: w.path,
    branch: w.branch,
    base: w.base,
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
  return reconcileOne(workDir, all[idx] as WorktreeRecord, checkoutPaths(workDir), now);
}

export interface SweepOutcome {
  slug: string;
  branch: string;
  state: WorktreeState;
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
export function sweepWorktrees(workDir: string, now = Date.now()): SweepOutcome[] {
  const out: SweepOutcome[] = [];
  for (const w of reconcileWorktrees(workDir, now)) {
    if (w.state === "running" || w.state === "session" || w.state === "ready") continue;
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
    const removedCheckout = w.checkoutPresent && gitOk(workDir, ["worktree", "remove", "--force", w.path]);
    gitOk(workDir, ["worktree", "prune"]);
    // `-D`, but only after our own proof: zero commits, or contained in another
    // ref. Never reached for `ready`, which is the state that holds real work.
    const deletedBranch = gitOk(workDir, ["branch", "-D", w.branch]);
    if (deletedBranch) {
      saveWorktrees(
        workDir,
        listWorktrees(workDir).filter((r) => r.branch !== w.branch),
      );
    }
    out.push({
      slug: w.slug,
      branch: w.branch,
      state: w.state,
      removedCheckout,
      deletedBranch,
      reason:
        w.state === "empty"
          ? "reclaimed — branch had no commits"
          : `reclaimed — already merged into ${w.mergedInto ?? "another branch"}`,
    });
  }
  return out;
}

/**
 * Is there work in the main tree a merge would disturb?
 *
 * `.marvin/` is excluded: the registry file this module itself writes lives
 * there, so a project that does not gitignore `.marvin/` would read as dirty
 * forever and every merge would refuse. MARVIN's own bookkeeping is not the
 * user's uncommitted work.
 */
function workingTreeDirty(workDir: string): boolean {
  return gitOr(workDir, ["status", "--porcelain"], "")
    .split("\n")
    .filter(Boolean)
    .some((l) => !l.slice(3).replace(/^"|"$/g, "").startsWith(".marvin/"));
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

export function mergeWorktree(
  workDir: string,
  slug: string,
  opts: { isSessionBusy?: (sessionId: string) => boolean } = {},
): MergeOutcome {
  const w = reconcileWorktrees(workDir).find((r) => r.slug === slug);
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
  if (workingTreeDirty(workDir)) {
    return fail("The main working tree has uncommitted changes — commit or stash before merging.");
  }
  const onto = gitOr(workDir, ["rev-parse", "--abbrev-ref", "HEAD"], "HEAD");
  try {
    git(workDir, ["merge", "--no-ff", "-m", mergeSubject(w.branch), "-m", w.task, w.branch]);
  } catch (err) {
    gitOk(workDir, ["merge", "--abort"]);
    return fail(`Merge of ${w.branch} into ${onto} failed and was aborted: ${err instanceof Error ? err.message : String(err)}`);
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
  if (workingTreeDirty(workDir)) {
    return {
      merged,
      skipped,
      message: "The main working tree has uncommitted changes — commit or stash before merging.",
    };
  }

  let stopped: MergeAllOutcome["stopped"];
  for (const w of candidates) {
    const out = mergeWorktree(workDir, w.slug, opts);
    if (out.ok) {
      merged.push({ slug: out.slug, branch: out.branch, message: out.message });
      continue;
    }
    stopped = { slug: out.slug, branch: out.branch || w.branch, message: out.message };
    break;
  }

  const onto = gitOr(workDir, ["rev-parse", "--abbrev-ref", "HEAD"], "HEAD");
  const head = merged.length === 0
    ? "Nothing merged."
    : `Merged ${merged.length} branch(es) into ${onto}. Not pushed — one push covers all of them.`;
  return {
    merged,
    skipped,
    ...(stopped ? { stopped } : {}),
    message: stopped ? `${head} Stopped at ${stopped.branch}: ${stopped.message}` : head,
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
  const underRoot = (abs: string): boolean =>
    !isInsideWorktree(abs, worktree) &&
    !isInsideWorktree(abs, join(root, ".marvin", "worktrees")) &&
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
