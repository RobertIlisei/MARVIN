// metered-ci — which shell commands spend the user's CI minutes.
//
// ## Why this exists
//
// ADR-0103 measured the cost of integration on the project MARVIN is used on
// (GitLab Free, 400 pipeline-minutes a month, already exceeded and topped up
// in cash):
//
//   | action                              | cost                          |
//   |-------------------------------------|-------------------------------|
//   | push a branch with no open MR       | no pipeline at all            |
//   | open a merge request                | ~10 min                       |
//   | merge to the default branch         | 19.8–27.7 min on a 2× runner  |
//   |                                     | = ~48 compute-minutes         |
//
// ADR-0107 then gave every chat tab its own worktree and branch, which made
// the arithmetic the user's problem: *"working 5 sessions and all commiting
// and pushing and merging to main, each with his own MR, means 5x~45 min"*.
// Five branches integrated one MR each is ~240 compute-minutes; the same five
// merged locally onto the branch they were cut from and pushed once is ~48.
//
// ## The line this draws
//
// Not "does it touch the remote". `git push` is deliberately absent: on a
// pipeline-gated project a push to a branch with no open MR starts nothing,
// and pushing is how work is backed up. What costs money is **opening a merge
// request**, **merging one**, and **starting a pipeline by hand**. Those three
// are what land here.
//
// The cost is also not recoverable in the way the permission model usually
// assumes. Closing an MR you just opened does not refund the pipeline it
// started — the minutes are spent the moment it opens. That is why this is
// gated in `auto` mode too rather than sitting in the ordinary confirm class,
// which `auto` bypasses wholesale.

/** What kind of metered work a command would start. */
export type MeteredCiRisk =
  /** Opens a merge/pull request — starts an MR pipeline. */
  | "opens-request"
  /** Merges a request — on the default branch this is the full suite. */
  | "merges-request"
  /** Starts a pipeline / workflow directly. */
  | "runs-pipeline";

export interface MeteredCiVerdict {
  risk: MeteredCiRisk;
  /** The subcommand that matched, for the confirm card. */
  verb: string;
}

interface Rule {
  re: RegExp;
  risk: MeteredCiRisk;
  verb: string;
}

/**
 * Read-only forms that share a prefix with a spending one. Checked FIRST, so
 * `glab mr list` and `gh pr view` never read as creating one.
 *
 * An explicit allow-list rather than cleverer regexes, for the same reason
 * `shared-tree` uses one: a false positive here silently disables the guard,
 * while a false positive on the spending side costs one confirm.
 */
const READ_ONLY: RegExp[] = [
  /\b(glab|gh)\s+(mr|pr)\s+(list|view|show|diff|checkout|status|note|todo)\b/,
  /\bglab\s+(ci|pipeline)\s+(list|view|status|get|trace|artifact)\b/,
  /\bgh\s+(run|workflow)\s+(list|view|watch|download)\b/,
  // Help output spends nothing, at any subcommand depth — `glab mr create
  // --help` is three words in, which a fixed two-word pattern missed.
  /\b(glab|gh)\s+(?:\S+\s+)+(?:--help|-h)(?:\s|$)/,
];

const RULES: Rule[] = [
  // ── Opening a request ─────────────────────────────────────────────────
  { re: /\bglab\s+mr\s+(create|new)\b/, risk: "opens-request", verb: "glab mr create" },
  { re: /\bgh\s+pr\s+create\b/, risk: "opens-request", verb: "gh pr create" },
  // `git push -o merge_request.create` opens an MR from the push itself —
  // the one push form that does start a pipeline (GitLab push options).
  { re: /\bgit\s+push\b.*\bmerge_request\.create\b/, risk: "opens-request", verb: "git push -o merge_request.create" },
  // `-o ci.variable` / `-o ci.skip` aside, a push option that requests a
  // pipeline is the same act.
  { re: /\bgit\s+push\b.*\bci\.pipeline\b/, risk: "runs-pipeline", verb: "git push -o ci.pipeline" },

  // ── Merging a request ─────────────────────────────────────────────────
  { re: /\bglab\s+mr\s+merge\b/, risk: "merges-request", verb: "glab mr merge" },
  { re: /\bgh\s+pr\s+merge\b/, risk: "merges-request", verb: "gh pr merge" },

  // ── Starting a pipeline directly ──────────────────────────────────────
  { re: /\bglab\s+ci\s+(run|trigger|retry)\b/, risk: "runs-pipeline", verb: "glab ci run" },
  { re: /\bglab\s+pipeline\s+(run|trigger|retry)\b/, risk: "runs-pipeline", verb: "glab pipeline run" },
  { re: /\bgh\s+workflow\s+run\b/, risk: "runs-pipeline", verb: "gh workflow run" },
  { re: /\bgh\s+run\s+rerun\b/, risk: "runs-pipeline", verb: "gh run rerun" },
];

/**
 * Would this command spend CI minutes?
 *
 * Returns `null` for everything else, including every plain `git push` — see
 * the note at the top of this file for why pushing is not on the list.
 */
export function classifyMeteredCiRisk(command: string): MeteredCiVerdict | null {
  const cmd = command.trim();
  if (!cmd) return null;
  // Cheap reject: every rule needs one of these three words.
  if (!/\b(glab|gh|git)\b/.test(cmd)) return null;
  if (READ_ONLY.some((re) => re.test(cmd))) return null;
  for (const rule of RULES) {
    if (rule.re.test(cmd)) return { risk: rule.risk, verb: rule.verb };
  }
  return null;
}

/** One-line explanation of a risk class, for the confirm card. */
export function describeMeteredCiRisk(risk: MeteredCiRisk): string {
  switch (risk) {
    case "opens-request":
      return "opens a merge request, which starts a pipeline on this project";
    case "merges-request":
      return "merges a request — on the default branch that is the full suite";
    case "runs-pipeline":
      return "starts a pipeline directly";
  }
}

/**
 * The advice on the confirm card. Names the cheaper path, because the whole
 * point of the gate is that a cheaper path exists and is one click away.
 */
export function meteredCiAlternative(risk: MeteredCiRisk): string {
  if (risk === "opens-request") {
    return (
      "A tab's branch is cut from the checkout's current HEAD, so folding it in " +
      "locally (close the tab with Merge, or Source Control ▸ Worktrees ▸ Merge all " +
      "ready) costs no pipeline at all — the commits ride along in whatever run that " +
      "branch was already going to have. One request for all of the work beats one each."
    );
  }
  return "Allow if this is the integration you intended; deny if it can wait to be batched.";
}
