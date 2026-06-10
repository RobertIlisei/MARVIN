/**
 * MARVIN tool-use policy.
 *
 * Every tool call is classified before execution:
 *   - `auto` — run without prompting (pure reads).
 *   - `confirm` — render an in-chat confirm card; block until user allows.
 *   - `deny`   — never run; surface a refusal to the user.
 *
 * The list is intentionally small. Tooling that might mutate state, spend
 * real money, or write to shared systems must be in `confirm` by default.
 */

export type ToolName =
  | "Bash"
  | "Edit"
  | "Write"
  | "Read"
  | "Grep"
  | "Glob"
  | "WebFetch"
  | "WebSearch"
  | "Task"
  | "NotebookEdit";

/**
 * Single source of truth for the tools MARVIN's gate inspects.
 *
 * Imported by `@marvin/runtime/sdk-runner` so a tool added here flows
 * to the gate without a second declaration. Previously sdk-runner
 * carried its own `KNOWN_TOOL_NAMES` Set — that's a drift risk and
 * was the audit-finding-#3 root cause (Task and NotebookEdit weren't
 * listed there, so they bypassed the gate entirely).
 *
 * See [docs/reviews/2026-04-26-full-audit.md, finding #3 + #21].
 */
export const KNOWN_TOOL_NAMES: ReadonlySet<ToolName> = new Set([
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
]);

export type ToolPolicyClass = "auto" | "confirm" | "deny";

const BASE: Record<ToolName, ToolPolicyClass> = {
  Read: "auto",
  Grep: "auto",
  Glob: "auto",
  // WebFetch / WebSearch reach the public internet. Auto-allowing
  // every fetch means a prompt-injection in source code MARVIN reads
  // can quietly egress to an attacker-controlled URL — audit 🟡 #16.
  // Move to `confirm` so the user sees the URL + the chosen domain
  // before MARVIN follows it. The cost is one click per web call,
  // which matches user expectations for "AI is about to make a network
  // request on my behalf." Scouts have WebFetch in their disallowedTools
  // (PR #91 / 🟠 #10), so this `confirm` only fires for the main session.
  WebFetch: "confirm",
  WebSearch: "confirm",
  Edit: "confirm",
  Write: "confirm",
  Bash: "confirm",
  // Task is special-cased below — sanctioned `subagent_type` values
  // (`scout`, `general-purpose`) auto-allow; bare/unknown subagents
  // require a confirm. This `BASE` entry is the fallback when the
  // special case does not match.
  Task: "confirm",
  NotebookEdit: "confirm",
};

/**
 * Subagent types MARVIN may dispatch via `Task` without a confirm
 * prompt. The set is small and ADR-bound:
 *   - `scout`           — read-only research subagent (ADR-0014).
 *   - `advisor`         — registered second-opinion agent carrying its
 *                         own model + reasoning effort (ADR-0033).
 *                         Read-only via disallowedTools + the agentID
 *                         mutation gate (ADR-0030).
 *   - `general-purpose` — the SDK's generic delegate; the legacy
 *                         advisor spawn shape (ADR-0007). Inherits the
 *                         parent session's tool set, so it remains
 *                         gated transitively.
 *
 * Adding a new entry requires an ADR per CLAUDE.md's deterministic
 * ADR triggers.
 */
const SANCTIONED_SUBAGENT_TYPES: ReadonlySet<string> = new Set([
  "scout",
  "advisor",
  "general-purpose",
]);

// Narrow regex whitelist for Bash commands that are safe enough to auto-run.
// Anything matching these can run without a confirm card.
const BASH_AUTO_ALLOW: RegExp[] = [
  /^git\s+(status|log|diff|show|rev-parse|branch|blame)\b/,
  /^npm\s+(ls|outdated|config\s+get)\b/,
  /^pnpm\s+(ls|list|outdated|config\s+get|why)\b/,
  /^node\s+--version$/,
  /^(pwd|whoami|uname|date|ls|cat\s+\S+)$/,
  /^(echo|printf)\s/,
  /^curl\s+-(s|I)/,
];

// Hard deny list — never run these without an explicit per-call override
// from the user, even if they're in a confirmed batch.
//
// The original list (audit finding #2) only matched a literal `/` after
// `-rf`, so `rm -rf $HOME/foo`, `rm -rf ~/foo`, `rm -rf ../foo` slipped
// through to the auto-allow regex (none) and from there to the
// `confirm` class — which in `auto` permission mode runs without a
// prompt. The patterns below close those gaps. Test coverage lives at
// `packages/tools/tests/policy.test.ts`.
//
// See [docs/reviews/2026-04-26-full-audit.md, finding #2].
const BASH_HARD_DENY: RegExp[] = [
  // `rm -rf` followed by anything that resolves to a rooted, home-,
  // tilde-, or parent-relative target. The `-r` and `-R` flags both
  // trigger; optional `f` because `-rf` and `-r` both warrant the same
  // protection here (the prompt is cheap).
  /\brm\s+-[rR]f?\s+\//,
  /\brm\s+-[rR]f?\s+\$HOME(\b|\/)/,
  // `~` and `..` are not word characters, so `\b` doesn't anchor
  // here. Match an explicit boundary instead — `/`, whitespace, or
  // end of string.
  /\brm\s+-[rR]f?\s+~(\/|\s|$)/,
  /\brm\s+-[rR]f?\s+\.\.(\/|\s|$)/,
  // wildcard glob deletes (`rm -rf *`, `rm -rf .*`) — easy footgun.
  /\brm\s+-[rR]f?\s+(\*|\.\*)/,
  // git destructive history rewrites
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+push\s+.*-f\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+--\s/,
  /\bgit\s+clean\s+-[fdx]/,
  // database destruction
  /\bdrop\s+(database|table|schema)\b/i,
  // permission / ownership sweeps
  /\bchown\s+-R\s+\//,
  /\bchmod\s+-R\s+777\b/,
  // pipe-to-shell installer pattern (`curl ... | sh`, `wget ... | bash`)
  /\b(curl|wget)\s+.+\|\s*(sh|bash|zsh)\b/,
];

export interface ToolPolicyDecision {
  class: ToolPolicyClass;
  /** Why the decision was made (for display in the confirm card). */
  reason: string;
}

export function toolPolicy(name: ToolName, input: Record<string, unknown>): ToolPolicyDecision {
  if (name === "Bash") {
    // Background Bash is hard-denied (ADR-0032). The SDK Bash tool's
    // `run_in_background` returns a shell id and expects the model to poll
    // output WITHIN the same turn ("Use Read to read the output later").
    // MARVIN's runtime has NO mechanism to re-invoke a turn when a
    // background process finishes — so "run it in the background, I'll be
    // notified on completion" is a promise that never fires once the turn
    // ends (the exact failure ADR-0031 fixed for time-based check-backs,
    // re-surfacing via Bash). Make it mechanical, not a prompt nudge:
    // refuse the call and steer to foreground or schedule_wakeup.
    if (input.run_in_background === true) {
      return {
        class: "deny",
        reason:
          "Background Bash is disabled (ADR-0032): MARVIN can't notify a turn " +
          "when a background process finishes, so it would silently never report. " +
          "Run the command foreground (raise `timeout` if it's slow), or for a " +
          "genuinely long job use `schedule_wakeup` to return later and check.",
      };
    }
    const cmd = typeof input.command === "string" ? input.command.trim() : "";
    if (BASH_HARD_DENY.some((r) => r.test(cmd))) {
      return { class: "deny", reason: "Matches a hard-deny pattern (destructive)." };
    }
    if (BASH_AUTO_ALLOW.some((r) => r.test(cmd))) {
      return { class: "auto", reason: "Read-only shell command." };
    }
    return { class: "confirm", reason: "Bash command not in the auto-allow list." };
  }
  if (name === "Task") {
    // ADR-0007 (advisor) and ADR-0014 (scout) sanction two
    // `subagent_type` values; everything else is a bare delegate that
    // inherits the parent's permission posture, which in `auto` mode
    // is bypass — a clear escalation surface (audit finding #3).
    const sub = typeof input.subagent_type === "string"
      ? input.subagent_type
      : "";
    if (sub && SANCTIONED_SUBAGENT_TYPES.has(sub)) {
      return {
        class: "auto",
        reason: `Sanctioned subagent (${sub}).`,
      };
    }
    return {
      class: "confirm",
      reason: sub
        ? `Unknown subagent_type "${sub}" — confirm before dispatch.`
        : "Bare Task call without subagent_type — confirm before dispatch.",
    };
  }
  return { class: BASE[name], reason: defaultReason(name, BASE[name]) };
}

function defaultReason(name: ToolName, cls: ToolPolicyClass): string {
  if (cls === "auto") return `${name} is a read-only tool.`;
  if (cls === "confirm") return `${name} mutates files — confirm required.`;
  return `${name} is not permitted.`;
}
