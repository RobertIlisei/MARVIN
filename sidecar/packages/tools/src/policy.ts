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
  | "Agent"
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
  "Agent",
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
  // Task / Agent are special-cased below — sanctioned `subagent_type`
  // values (`scout`, `general-purpose`) auto-allow; bare/unknown
  // subagents require a confirm. These `BASE` entries are the fallback
  // when the special case does not match. Both spellings are listed
  // because the SDK renamed the tool (see SUBAGENT_DISPATCH_TOOLS).
  Task: "confirm",
  Agent: "confirm",
  NotebookEdit: "confirm",
};

/**
 * The tool names that dispatch a subagent.
 *
 * Claude Code renamed this tool `Task` → `Agent` in v2.1.63. MARVIN's gate,
 * design hooks and ADR-0058 model remap all matched the literal `"Task"`, so
 * every one of them became dead code the moment the rename landed — a scan of
 * 12 real transcripts found **200 dispatches, all named `Agent`, none named
 * `Task`**. Worse, `Agent` was absent from `KNOWN_TOOL_NAMES`, so
 * `classifyToolCall` fell through to its not-in-the-gated-set blanket-allow
 * and subagent dispatch was ungated entirely.
 *
 * `system/init` still advertises the old name, which is why the earlier
 * verification recorded in CLAUDE.md concluded `Task`; the `tool_use` blocks
 * that the gate actually sees carry the new one. Match BOTH — the old name
 * costs nothing and keeps older SDK pins working.
 */
export const SUBAGENT_DISPATCH_TOOLS: ReadonlySet<string> = new Set(["Task", "Agent"]);

/** True when `name` is the subagent-dispatch tool under either spelling. */
export function isSubagentDispatch(name: string): boolean {
  return SUBAGENT_DISPATCH_TOOLS.has(name);
}

/**
 * Rename canary (ADR-0088).
 *
 * `isSubagentDispatch` matches names we already know. ADR-0079 is the record
 * of what a name we DIDN'T know costs: five guards went dead and dispatch ran
 * ungated for months, because every check was written against a literal.
 * Matching the name is inherently one rename behind.
 *
 * The tool's SHAPE is not. A call carrying `subagent_type` is a subagent
 * dispatch whatever it is called, so an unrecognised tool with that input is
 * almost certainly the next rename. Treat it as a dispatch — which routes it
 * through the sanctioned-type check rather than the not-in-the-gated-set
 * blanket-allow — and say so loudly enough to be found.
 */
export function looksLikeSubagentDispatch(
  name: string,
  input: Record<string, unknown> | undefined | null,
): boolean {
  if (isSubagentDispatch(name)) return false;
  // `classifyToolCall` is reachable with no input at all (the SDK omits it
  // for some calls) — a canary that throws would take the turn with it.
  const type = input?.subagent_type;
  return typeof type === "string" && type.length > 0;
}

/**
 * Subagent types MARVIN may dispatch via `Task` / `Agent` without a confirm
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
  // ADR-0058 — cheap, parallel graph-extraction subagent (Haiku tier). Its
  // writes are gate-scoped to graphify-out/; read-only discovery otherwise.
  "graph-extractor",
  // ADR-0080 — Claude Code's built-in READ-ONLY agents. Six real dispatches in
  // the 2026-08-29 transcript scan; confirm-gating them added a click to a
  // codebase search with no security value. Both are read-only by the SDK's
  // own definition, and the agentID invariant applies regardless.
  "Explore",
  "Plan",
  // ADR-0081 — the worktree-isolated builder. Its writes are allowed ONLY
  // inside a MARVIN-created worktree (see `implementerWorktreePolicy`).
  "implementer",
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
/**
 * Shell-level backgrounding (ADR-0038). A trailing single `&` (not `&&`,
 * not `&>`), or `nohup` / `setsid` / `disown` anywhere. The negative
 * lookbehind `(?<![&>])` spares `a && b` and `cmd &> log`; the trailing
 * group requires end-of-line / newline / comment so `a & b` mid-pipeline
 * isn't the target (rare) but `cmd &` is.
 */
const SHELL_BACKGROUND_RE = /(?<![&>])&[ \t]*(?:$|\n|#)|\bnohup\b|\bsetsid\b|\bdisown\b/m;

/**
 * Outward-facing publish / release commands (ADR-0077).
 *
 * `auto` permission strategy bypasses the `confirm` class outright
 * (`sdk-runner.ts` — "auto-mode bypass: <reason>"), so a command that only
 * reached `confirm` because it missed the auto-allow list still RUNS with no
 * human in the loop. For a destructive local command that is recoverable; for
 * `gh release create` or `npm publish` it is not — the artefact is on a CDN and
 * in other people's caches before anyone sees the turn.
 *
 * Anthropic's AI-native SDLC playbook names this the "unbounded autonomy"
 * anti-pattern and prescribes a *named release authorization* gate. MARVIN's
 * ship flow is human-run anyway (commit -> FF push to main -> tag), so denying
 * the publish verbs costs nothing and closes the one class of action the
 * permission model cannot take back.
 *
 * Deliberately NOT denied: `git tag` (a local tag publishes nothing) and
 * `git push` to a branch (recoverable, and the ship flow's normal path).
 * It is the *tag push* that triggers `release.yml`, so that is what is caught.
 */
const PUBLISH_HARD_DENY: RegExp[] = [
  // GitHub releases — creates/edits a public release + uploads assets.
  /\bgh\s+release\s+(create|edit|upload|delete)\b/,
  // Package registries.
  /\b(npm|pnpm|yarn|bun)\s+publish\b/,
  /\bcargo\s+publish\b/,
  /\b(twine\s+upload|python\s+-m\s+twine\s+upload)\b/,
  // Container registries.
  /\bdocker\s+push\b/,
  // Tag pushes — this is what fires release.yml.
  /\bgit\s+push\s+.*--tags\b/,
  /\bgit\s+push\s+\S+\s+(refs\/tags\/|v?\d+\.\d+)/,
  // Manually dispatching the release workflow.
  /\bgh\s+workflow\s+run\s+.*release\b/,
];

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

/**
 * Is this path a test file? (ADR-0077)
 *
 * Deliberately broad across ecosystems — the guard below only fires on
 * unambiguous weakening, so a false positive on "is a test file" costs
 * nothing while a false negative loses the protection entirely.
 */
const TEST_FILE_RE =
  /(^|[/\\])(tests?|__tests__|spec|specs)[/\\]|\.(test|spec)\.[cm]?[jt]sx?$|(^|[/\\])test_[^/\\]+\.py$|[^/\\]+_test\.(py|go|rb)$|Tests?\.swift$/;

/**
 * Markers that disable a test outright. Introducing any of these into a test
 * file turns a red test green without touching the code under test.
 *
 * `.only` is included: it does not disable the test it is attached to, it
 * disables every *other* test in the file — same outcome, less obvious.
 */
const TEST_DISABLE_RE =
  /\b(?:it|test|describe|context|suite|bench)\s*\.\s*(?:skip|only|todo|failing|skipIf|concurrent\s*\.\s*skip)\b|\bx(?:it|test|describe)\s*\(|@(?:Ignore|Disabled)\b|\bt\.Skip\(|\bpytest\.mark\.(?:skip|xfail)\b|\bunittest\.skip\b/;

/** Assertion forms, counted to detect a test being gutted. */
const ASSERTION_RE = /\bexpect\s*\(|\bassert(?:\b|_)|\bXCTAssert\w*\s*\(|\bshould\s*\.|\.to\s*\.\s*(?:equal|be)\b/g;

const countAssertions = (src: string): number => (src.match(ASSERTION_RE) ?? []).length;

/** A line that asserts, and has been commented out rather than deleted. */
const COMMENTED_ASSERTION_RE =
  /^[ \t]*(?:\/\/|#|\*|--)[ \t]*(?:expect\s*\(|assert\b|XCTAssert\w*\s*\()/m;

/**
 * Test-weakening guard (ADR-0077).
 *
 * Anthropic's AI-native SDLC playbook names "agent edits the test until it
 * passes" as an anti-pattern that deterministic controls, not prose, must
 * catch. MARVIN had no guard on this at any layer: `Edit` and `Write` are
 * `confirm`, and `auto` strategy bypasses `confirm`.
 *
 * The hard constraint is that this MUST NOT block legitimate test authoring —
 * `test-driven-development` is a MUST-trigger skill and RED-GREEN-REFACTOR
 * requires writing tests constantly. So a blanket "deny edits to test files"
 * is wrong. This fires only on shapes that are unambiguously *weakening*:
 *
 *   1. A disable marker (`.skip` / `.only` / `.todo` / `xit` / `@Disabled` /
 *      `pytest.mark.skip` / `t.Skip`) appears in the new text and did not
 *      appear in the old.
 *   2. An assertion is commented out rather than removed or fixed.
 *   3. The edit removes EVERY assertion from the region it touches
 *      (count > 0 -> 0). A partial drop is allowed — consolidating three
 *      `expect`s into one `toMatchObject` is legitimate refactoring, and
 *      precision matters more here than recall.
 *
 * Adding new tests always increases the assertion count, so TDD is untouched.
 */
function testWeakeningDenial(
  name: ToolName,
  input: Record<string, unknown>,
): ToolPolicyDecision | null {
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (!filePath || !TEST_FILE_RE.test(filePath)) return null;

  const before = typeof input.old_string === "string" ? input.old_string : "";
  const after =
    typeof input.new_string === "string"
      ? input.new_string
      : typeof input.content === "string"
        ? input.content
        : "";
  if (!after && !before) return null;

  const steer =
    " Fix the code under test, or explain to the user why the test itself is " +
    "wrong and let them make the call. If the test is genuinely obsolete, say " +
    "so and ask — do not disable it silently.";

  if (TEST_DISABLE_RE.test(after) && !TEST_DISABLE_RE.test(before)) {
    return {
      class: "deny",
      reason:
        `Refused (ADR-0077): this ${name} introduces a test-disable marker ` +
        `(.skip / .only / .todo / xit / @Disabled) into ${filePath}. ` +
        `Disabling a test makes the suite green without making the code correct.` +
        steer,
    };
  }

  if (COMMENTED_ASSERTION_RE.test(after) && !COMMENTED_ASSERTION_RE.test(before)) {
    return {
      class: "deny",
      reason:
        `Refused (ADR-0077): this ${name} comments out an assertion in ` +
        `${filePath}. A commented assertion is a deleted assertion that still ` +
        `looks like coverage.` + steer,
    };
  }

  // Only meaningful for Edit, where `old_string` gives us the before-state.
  if (name === "Edit" && before) {
    const had = countAssertions(before);
    if (had > 0 && countAssertions(after) === 0) {
      return {
        class: "deny",
        reason:
          `Refused (ADR-0077): this Edit removes all ${had} assertion(s) from ` +
          `the region it touches in ${filePath}, leaving a test that cannot ` +
          `fail.` + steer,
      };
    }
  }

  return null;
}

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
          "Background Bash is disabled (ADR-0032): the SDK's run_in_background " +
          "expects you to poll within the same turn. For a job that outlives the " +
          "turn, use the `run_background_job` tool — it spawns a tracked process " +
          "and starts a REAL follow-up turn when the job exits (ADR-0038).",
      };
    }
    const cmd = typeof input.command === "string" ? input.command.trim() : "";
    // ADR-0038 — close the shell-backgrounding gap. The run_in_background
    // FLAG was denied, but `cmd &` / nohup / setsid / disown detach a
    // process at the shell level (the tool call returns immediately) and
    // orphan it: nothing watches it, so MARVIN narrates "I'll be notified"
    // and forgets. Deny those and steer to `run_background_job`, which has a
    // real completion wakeup. The negative lookbehind spares `&&` and `&>`.
    if (SHELL_BACKGROUND_RE.test(cmd)) {
      return {
        class: "deny",
        reason:
          "Shell backgrounding (`&` / nohup / setsid / disown) is disabled " +
          "(ADR-0038): a detached process is orphaned — nothing fires a turn " +
          "when it finishes, so you'd never hear back. Use the " +
          "`run_background_job` tool instead — it tracks the process and starts " +
          "a real follow-up turn on exit. For a short command, run it foreground.",
      };
    }
    if (BASH_HARD_DENY.some((r) => r.test(cmd))) {
      return { class: "deny", reason: "Matches a hard-deny pattern (destructive)." };
    }
    // ADR-0077 — outward-facing publish is not recoverable, and `auto`
    // strategy bypasses `confirm`, so `confirm` is not a gate here.
    if (PUBLISH_HARD_DENY.some((r) => r.test(cmd))) {
      return {
        class: "deny",
        reason:
          "Refused (ADR-0077): this publishes an artefact outside the machine " +
          "(release, package registry, container registry, or a tag push that " +
          "triggers the release workflow). That cannot be undone once caches " +
          "and mirrors have it, and the default `auto` strategy would run it " +
          "with no human in the loop. Tell the user the exact command and let " +
          "them run it.",
      };
    }
    if (BASH_AUTO_ALLOW.some((r) => r.test(cmd))) {
      return { class: "auto", reason: "Read-only shell command." };
    }
    return { class: "confirm", reason: "Bash command not in the auto-allow list." };
  }
  if (isSubagentDispatch(name) || looksLikeSubagentDispatch(name, input)) {
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
        : `Bare ${name} call without subagent_type — confirm before dispatch.`,
    };
  }
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
    const weakening = testWeakeningDenial(name, input);
    if (weakening) return weakening;
  }
  return { class: BASE[name], reason: defaultReason(name, BASE[name]) };
}

function defaultReason(name: ToolName, cls: ToolPolicyClass): string {
  if (cls === "auto") return `${name} is a read-only tool.`;
  if (cls === "confirm") return `${name} mutates files — confirm required.`;
  return `${name} is not permitted.`;
}

// ── External MCP server classification (ADR-0045, generalized ADR-0053) ──────
//
// The gate auto-allows any tool NOT in KNOWN_TOOL_NAMES. That is safe ONLY for
// MARVIN's own in-process servers (graph/memory/backlog/control — all read-only)
// — NOT for an external server like Playwright MCP (egress + host-code exec) or
// a Claude Code PLUGIN's MCP server (arbitrary, unknown-trust tools). So the
// policy INVERTS the default: MARVIN's in-process servers are allowlisted (→
// null → blanket-allow); every OTHER `mcp__*` tool goes through the ladder.
// `classifyToolCall` consults this BEFORE the blanket-allow, so the subagent
// read-only collapse applies to anything that resolves to confirm/deny.
//
// Before ADR-0053 this returned null for everything non-Playwright, which
// blanket-allowed plugin MCP tools ungated even in gated mode. The inversion
// closes that hole at the source rather than per-server.

/** Prefixes of MARVIN's trusted, read-only, in-process MCP servers. Tools under
 *  these keep the blanket-allow; nothing else does. Keep in lockstep with the
 *  `mcpServers` MARVIN registers in `sdk-runner.ts`. */
const TRUSTED_INPROCESS_MCP_PREFIXES: readonly string[] = [
  "mcp__marvin-graph__",
  "mcp__marvin-memory__",
  "mcp__marvin-backlog__",
  "mcp__marvin-control__",
];

/** The mcpServers key MARVIN registers Playwright under → tools arrive as
 *  `mcp__playwright__browser_*`. Shared with sdk-runner's registration. */
export const PLAYWRIGHT_SERVER_KEY = "playwright";
const PLAYWRIGHT_PREFIX = `mcp__${PLAYWRIGHT_SERVER_KEY}__`;

// Observational / read-only — safe to auto-run (and the only browser tools a
// read-only sub-agent gets).
const PLAYWRIGHT_AUTO: ReadonlySet<string> = new Set([
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_wait_for",
  "browser_tabs",
]);

// Arbitrary host-code execution — never without an explicit per-call override.
const PLAYWRIGHT_DENY: ReadonlySet<string> = new Set(["browser_run_code_unsafe"]);

/**
 * Classify an MCP tool name.
 *
 * - Returns `null` for MARVIN's trusted in-process servers (graph/memory/
 *   backlog/control) — the caller keeps the blanket-allow. Also `null` for a
 *   non-MCP name (not our concern).
 * - Playwright: the auto/deny/confirm ladder (ADR-0045).
 * - Every OTHER `mcp__*` tool — i.e. a plugin-contributed MCP server
 *   (ADR-0053) — falls to `confirm`: unknown trust, assume state-changing /
 *   egress. The subagent read-only invariant then hard-denies it for any
 *   `agentID` call (confirm ≠ allow).
 */
export function mcpToolPolicy(name: string): ToolPolicyClass | null {
  if (!name.startsWith("mcp__")) return null;
  // MARVIN's own in-process servers stay blanket-allowed.
  if (TRUSTED_INPROCESS_MCP_PREFIXES.some((p) => name.startsWith(p))) return null;
  if (name.startsWith(PLAYWRIGHT_PREFIX)) {
    const tool = name.slice(PLAYWRIGHT_PREFIX.length);
    if (PLAYWRIGHT_DENY.has(tool)) return "deny";
    if (PLAYWRIGHT_AUTO.has(tool)) return "auto";
    return "confirm";
  }
  // Any other external MCP server (Claude Code plugin, etc.): gate by default.
  return "confirm";
}
