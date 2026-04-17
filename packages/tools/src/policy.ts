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
  | "WebSearch";

export type ToolPolicyClass = "auto" | "confirm" | "deny";

const BASE: Record<ToolName, ToolPolicyClass> = {
  Read: "auto",
  Grep: "auto",
  Glob: "auto",
  WebFetch: "auto",
  WebSearch: "auto",
  Edit: "confirm",
  Write: "confirm",
  Bash: "confirm",
};

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
const BASH_HARD_DENY: RegExp[] = [
  /\brm\s+-rf\s+\//,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+--\s/,
  /\bdrop\s+(database|table|schema)\b/i,
  /\bchown\s+-R\s+\//,
];

export interface ToolPolicyDecision {
  class: ToolPolicyClass;
  /** Why the decision was made (for display in the confirm card). */
  reason: string;
}

export function toolPolicy(name: ToolName, input: Record<string, unknown>): ToolPolicyDecision {
  if (name === "Bash") {
    const cmd = typeof input.command === "string" ? input.command.trim() : "";
    if (BASH_HARD_DENY.some((r) => r.test(cmd))) {
      return { class: "deny", reason: "Matches a hard-deny pattern (destructive)." };
    }
    if (BASH_AUTO_ALLOW.some((r) => r.test(cmd))) {
      return { class: "auto", reason: "Read-only shell command." };
    }
    return { class: "confirm", reason: "Bash command not in the auto-allow list." };
  }
  return { class: BASE[name], reason: defaultReason(name, BASE[name]) };
}

function defaultReason(name: ToolName, cls: ToolPolicyClass): string {
  if (cls === "auto") return `${name} is a read-only tool.`;
  if (cls === "confirm") return `${name} mutates files — confirm required.`;
  return `${name} is not permitted.`;
}
