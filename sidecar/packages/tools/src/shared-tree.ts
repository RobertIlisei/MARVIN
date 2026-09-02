// shared-tree — which shell commands are unsafe when two MARVIN sessions
// share one working tree.
//
// ## Why this exists
//
// Golden Rule 1 forbids model-dispatching-model on shared state. It does not
// forbid a human running several sessions against one checkout, and the user
// does exactly that. On 2026-09-01 two sessions ran in
// `~/Projects/agri-saas-platform` — one triaging dependency MRs, one hotfixing
// a production container — and the tree's reflog records what happened:
//
//     checkout: moving from dep/errorprone to chore/dependabot-mr-triage-…
//     rebase (start): checkout gitlab/main
//     checkout: moving from chore/dependabot-mr-triage-… to dep/openapi-fetch
//
// The triage session branch-hopped and rebased while the hotfix session was
// reading and editing the same files. Neither session was wrong; the tree was
// pulled out from under one of them. The user's report was that the sessions
// had become "interconnected".
//
// ## Why not worktrees
//
// Worktrees are Claude Code's documented isolation and they do solve this, but
// the user's requirement is explicitly that multiple sessions work in ONE
// tree. Anthropic's own precedent for that shape is agent teams, which run
// several full sessions in a single directory and are documented as:
//
//   > Agent teams don't isolate teammates in worktrees, so partition the work
//   > so each teammate owns a different set of files.
//   > Two teammates editing the same file leads to overwrites.
//   > Task claiming uses file locking to prevent race conditions.
//
// So the supported answer for a shared tree is not isolation and not refusal —
// it is to make the collision visible at the moment it would happen. That is
// what this module classifies, and what the gate turns into a confirm naming
// the other session.
//
// ## The line this draws
//
// A command lands here when it changes what HEAD points at, or rewrites
// tracked files across the whole tree. Those are the operations one session
// cannot do without changing what every other session in the tree is looking
// at. Ordinary edits are deliberately NOT here: two sessions editing different
// files is the case the user wants to work, and the ownership-partitioning
// advice above is guidance, not something a regex can enforce.

/** What kind of shared-tree change a command would make. */
export type SharedTreeRisk =
  /** Moves HEAD — every other session's files change underneath it. */
  | "moves-head"
  /** Rewrites commits the other session may be building on. */
  | "rewrites-history"
  /** Replaces tracked file contents wholesale. */
  | "rewrites-worktree";

export interface SharedTreeVerdict {
  risk: SharedTreeRisk;
  /** The git subcommand that matched, for the confirm card. */
  verb: string;
}

interface Rule {
  re: RegExp;
  risk: SharedTreeRisk;
  verb: string;
}

/**
 * Read-only forms that share a prefix with a mutating one. Checked FIRST, so
 * `git stash list` never reads as `git stash`.
 *
 * Kept as an explicit allow-list rather than smarter regexes: a false positive
 * here silently disables the guard, while a false positive on the mutating
 * side only costs one confirm.
 */
const READ_ONLY: RegExp[] = [
  /\bgit\s+stash\s+(list|show)\b/,
  /\bgit\s+worktree\s+list\b/,
  /\bgit\s+branch\s+(-l\b|--list\b|-a\b|--all\b|-v\b|--verbose\b|-r\b|--remotes\b)/,
  /\bgit\s+bisect\s+(log|view|visualize)\b/,
  // `git checkout --help` / `git switch -h` document, they don't move.
  /\bgit\s+\S+\s+(--help|-h)\b/,
];

const RULES: Rule[] = [
  // ── Moves HEAD ────────────────────────────────────────────────────────
  // `git checkout -- <path>` is hard-denied upstream in policy.ts; what is
  // left here is the ref-changing form.
  { re: /\bgit\s+checkout\b/, risk: "moves-head", verb: "git checkout" },
  { re: /\bgit\s+switch\b/, risk: "moves-head", verb: "git switch" },
  { re: /\bgit\s+reset\b/, risk: "moves-head", verb: "git reset" },
  // `git pull` is fetch + merge/rebase: it moves HEAD and can rewrite.
  { re: /\bgit\s+pull\b/, risk: "moves-head", verb: "git pull" },
  { re: /\bgit\s+bisect\b/, risk: "moves-head", verb: "git bisect" },

  // ── Rewrites history ──────────────────────────────────────────────────
  { re: /\bgit\s+rebase\b/, risk: "rewrites-history", verb: "git rebase" },
  { re: /\bgit\s+merge\b/, risk: "rewrites-history", verb: "git merge" },
  { re: /\bgit\s+cherry-pick\b/, risk: "rewrites-history", verb: "git cherry-pick" },
  { re: /\bgit\s+commit\s+.*--amend\b/, risk: "rewrites-history", verb: "git commit --amend" },
  { re: /\bgit\s+filter-branch\b/, risk: "rewrites-history", verb: "git filter-branch" },

  // ── Rewrites the worktree ─────────────────────────────────────────────
  // `git clean -fdx` is hard-denied upstream; the bare form still removes.
  { re: /\bgit\s+stash\b/, risk: "rewrites-worktree", verb: "git stash" },
  { re: /\bgit\s+restore\b/, risk: "rewrites-worktree", verb: "git restore" },
  { re: /\bgit\s+am\b/, risk: "rewrites-worktree", verb: "git am" },
  { re: /\bgit\s+apply\b/, risk: "rewrites-worktree", verb: "git apply" },
];

/**
 * Would this command change the tree out from under another session?
 *
 * Returns `null` for everything else — including every non-git command and
 * every read-only git command. The caller only asks the (more expensive)
 * "is another session live in this tree" question when this says yes.
 */
export function classifySharedTreeRisk(command: string): SharedTreeVerdict | null {
  const cmd = command.trim();
  if (!cmd.includes("git")) return null;
  if (READ_ONLY.some((re) => re.test(cmd))) return null;
  for (const rule of RULES) {
    if (rule.re.test(cmd)) return { risk: rule.risk, verb: rule.verb };
  }
  return null;
}

/** One-line explanation of a risk class, for the confirm card. */
export function describeSharedTreeRisk(risk: SharedTreeRisk): string {
  switch (risk) {
    case "moves-head":
      return "moves HEAD, so every file in the shared tree changes underneath the other session";
    case "rewrites-history":
      return "rewrites commits the other session may already be building on";
    case "rewrites-worktree":
      return "replaces tracked file contents the other session may be editing";
  }
}
