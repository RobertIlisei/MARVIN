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
export type WorktreeState = "running" | "empty" | "ready" | "merged";

export interface WorktreeRecord {
  slug: string;
  /** Absolute path of the checkout. */
  path: string;
  branch: string;
  /** Commit the branch was cut from. */
  base: string;
  createdAt: string;
  /** One line: what the implementer was asked to do. */
  task: string;
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
  return (
    `${w.slug} [${w.state}${where}${dirty}]: ${w.branch} — ` +
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
function uniqueSlug(workDir: string, base: string, existing: readonly WorktreeRecord[]): string {
  const taken = (s: string) =>
    existing.some((w) => w.slug === s) || gitOk(workDir, ["rev-parse", "--verify", "--quiet", `${BRANCH_PREFIX}${s}`]);
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
  let mergedInto: string | undefined;
  if (stillRunning) {
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
    const slug = branch.slice(BRANCH_PREFIX.length);
    const guessed = join(worktreesDir(workDir), slug);
    const path = checkouts.has(canonical(guessed))
      ? guessed
      : [...checkouts].find((c) => c.endsWith(`/${slug}`)) ?? guessed;
    return {
      slug,
      path,
      branch,
      base: gitOr(workDir, ["merge-base", branch, "HEAD"], gitOr(workDir, ["rev-parse", branch], "")),
      createdAt: new Date(0).toISOString(),
      task: "(adopted — branch found outside the registry)",
      finishedAt: new Date(0).toISOString(),
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
    if (w.state === "running" || w.state === "ready") continue;
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

export function mergeWorktree(workDir: string, slug: string): MergeOutcome {
  const w = reconcileWorktrees(workDir).find((r) => r.slug === slug);
  if (!w) return { ok: false, message: `No worktree named ${slug}.`, slug, branch: "" };
  const fail = (message: string): MergeOutcome => ({ ok: false, message, slug, branch: w.branch });
  if (w.state === "running") return fail(`${w.branch} is still being built by its implementer.`);
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
