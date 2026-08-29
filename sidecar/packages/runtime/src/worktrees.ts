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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { toolPolicy } from "@marvin/tools/policy";

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
  let slug = worktreeSlug(task);
  if (existing.some((w) => w.slug === slug)) slug = `${slug}-${existing.length + 1}`;
  const path = join(worktreesDir(workDir), slug);
  const branch = `${BRANCH_PREFIX}${slug}`;
  mkdirSync(worktreesDir(workDir), { recursive: true });
  git(workDir, ["worktree", "add", "-q", "-b", branch, path, "HEAD"]);
  const base = git(workDir, ["rev-parse", "HEAD"]);
  excludeWorktreesDir(workDir);
  const record: WorktreeRecord = { slug, path, branch, base, createdAt: new Date().toISOString(), task };
  saveWorktrees(workDir, [...existing, record]);
  return record;
}

/**
 * Remove a worktree checkout. The BRANCH is kept — it is the deliverable, and
 * deleting it is the user's decision after they have merged or rejected it.
 */
export function removeWorktree(workDir: string, slug: string): WorktreeRecord | null {
  const existing = listWorktrees(workDir);
  const record = existing.find((w) => w.slug === slug);
  if (!record) return null;
  try {
    git(workDir, ["worktree", "remove", "--force", record.path]);
  } catch {
    /* already gone on disk — still drop the registry entry */
  }
  saveWorktrees(
    workDir,
    existing.filter((w) => w.slug !== slug),
  );
  return record;
}

/** Summary an implementer can be briefed with and the user can review from. */
export function describeWorktree(workDir: string, record: WorktreeRecord): string {
  let ahead = "?";
  try {
    ahead = git(workDir, ["rev-list", "--count", `${record.base}..${record.branch}`]);
  } catch {
    /* branch may not exist yet */
  }
  return `${record.slug}: ${record.path} on ${record.branch} (${ahead} commit(s) ahead of ${record.base.slice(0, 7)}) — ${record.task}`;
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
