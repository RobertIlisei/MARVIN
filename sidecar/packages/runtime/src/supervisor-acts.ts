/**
 * The human-only acts (ADR-0127 §4), read from the act itself.
 *
 * Inside a supervisor-touched turn every act this returns raises a confirm
 * only the user can answer (§5). The classification is deterministic — the
 * tool name and its input, and for a confirm the rule that raised it — never
 * anyone's description of the act.
 *
 * - **integration** — pushing, merging, opening or merging a request, CI.
 * - **containment** — ADR-0102's HEAD-moving / history-rewriting commands.
 *   That rule exists for a checkout other tabs share, so in a tab's own
 *   worktree `git pull` / `git stash` / `git checkout -b` are routine; the
 *   ADR-0107 session-worktree rule covers a worktree tab reaching out.
 * - **discard** — throwing away uncommitted work or a branch.
 * - **boundary-path** — a write to a path on the ship-review gate's list
 *   (`matchShipBoundary`, ADR-0104): one list, not a second copy. Plain shell
 *   writes (redirect, `tee`, `cp`, `mv`, `install`, `sed -i`) count;
 *   obfuscated ones are out of scope (ADR-0127 §5).
 * - **external-mcp** — a tool on a server MARVIN did not register: its
 *   effects (merge, deploy, run a pipeline) are unknown, so they are the
 *   user's.
 */

import path from "node:path";

import { classifyMeteredCiRisk } from "@marvin/tools/metered-ci";
import { isTrustedMcpName, PLAYWRIGHT_SERVER_KEY } from "@marvin/tools/policy";
import { classifySharedTreeRisk } from "@marvin/tools/shared-tree";

import type { ConfirmRule } from "./confirm-registry";
import { matchShipBoundary } from "./design-hooks";

export type HumanOnlyItem = "integration" | "containment" | "discard" | "boundary-path" | "external-mcp";

export interface HumanOnlyAct {
  item: HumanOnlyItem;
  /** What the act is, for the confirm card — built from the input, never from model text. */
  label: string;
}

/** Confirm kinds that are §4 acts by the rule that raised them. */
export const HUMAN_ONLY_CONFIRM_RULES: ReadonlySet<ConfirmRule> = new Set<ConfirmRule>([
  "supervisor-touched",
  "shared-tree",
  "metered-ci",
  "lane",
  "session-worktree",
]);

const INTEGRATION: ReadonlyArray<[RegExp, string]> = [
  [/\bgit\s+push\b/, "git push"],
  [/\bgit\s+merge(\s|$)/, "git merge"],
  [/\b(gh\s+pr|glab\s+mr)\s+(create|merge)\b/, "a merge / pull request"],
];

const DISCARD: ReadonlyArray<[RegExp, string]> = [
  [/\bgit\s+reset\b[^|;&\n]*--hard\b/, "git reset --hard"],
  [/\bgit\s+checkout\s+(--\s|\.(\s|$))/, "git checkout -- (discards changes)"],
  [/\bgit\s+restore\b(?![^|;&\n]*--staged)/, "git restore (discards changes)"],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, "git clean -f"],
  [/\bgit\s+worktree\s+remove\b/, "git worktree remove"],
  [/\bgit\s+branch\s+[^|;&\n]*-D\b/, "git branch -D"],
  [/\bgit\s+stash\s+(drop|clear)\b/, "git stash drop / clear"],
];

const CONTROL_ACTS: Readonly<Record<string, HumanOnlyAct>> = {
  "mcp__marvin-control__worktree_merge": { item: "integration", label: "merge a worktree branch" },
  "mcp__marvin-control__worktree_remove": { item: "discard", label: "remove a worktree" },
};

/**
 * `git -C dir <sub>`, `git -c k=v <sub>` and `git --git-dir=… <sub>` run the
 * same subcommand as `git <sub>`. The command is classified with git's global
 * options removed, so they cannot hide what it does (milestone 3 audit).
 */
const GIT_GLOBAL_OPTIONS =
  /\bgit((?:\s+(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)(?:=\S+|\s+\S+)|\s+(?:--no-pager|--paginate|-p|-P|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks))+)(?=\s|$)/g;

export function withoutGitGlobalOptions(command: string): string {
  return command.replace(GIT_GLOBAL_OPTIONS, "git");
}

const unquote = (s: string) => s.replace(/^['"]|['"]$/g, "");

/** A repo-relative path for the ship list; an absolute path outside the tree stays absolute. */
function relTo(cwd: string, p: string): string {
  const raw = unquote(p).replace(/^\.\//, "");
  if (!path.isAbsolute(raw)) return raw;
  const rel = path.relative(cwd, raw);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : raw;
}

/** Paths a plain shell command writes. */
export function shellWriteTargets(command: string): string[] {
  const out: string[] = [];
  for (const seg of command.split(/&&|\|\||[;|\n]/)) {
    for (const m of seg.matchAll(/(?<![<>&\d])>{1,2}(?!&)\s*([^\s;&|<>()]+)/g)) if (m[1]) out.push(m[1]);
    const words = seg.trim().split(/\s+/).filter(Boolean);
    const cmd = words[0];
    const args = words.slice(1).filter((w) => !w.startsWith("-") && !w.startsWith("<") && !w.startsWith(">"));
    if (cmd === "tee") out.push(...args);
    if ((cmd === "cp" || cmd === "mv" || cmd === "install") && args.length >= 2) out.push(args[args.length - 1] as string);
    if (cmd === "sed" && words.some((w) => w === "-i" || w.startsWith("-i")) && args.length) out.push(args[args.length - 1] as string);
  }
  return out.map(unquote).filter(Boolean);
}

export function classifyHumanOnlyAct(args: {
  toolName: string;
  input: Record<string, unknown>;
  /** The tab's checkout — relative paths resolve against it. */
  cwd: string;
  /** `worktree` for a tab in its own tree; anything else is a shared checkout. */
  treeMode?: "shared" | "worktree" | undefined;
}): HumanOnlyAct | null {
  const { toolName, input, cwd } = args;

  if (toolName.startsWith("mcp__")) {
    const control = CONTROL_ACTS[toolName];
    if (control) return control;
    if (isTrustedMcpName(toolName) || toolName.startsWith(`mcp__${PLAYWRIGHT_SERVER_KEY}__`)) return null;
    return { item: "external-mcp", label: `${toolName} (a server MARVIN did not register)` };
  }

  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit" || toolName === "MultiEdit") {
    const raw = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof raw !== "string" || !raw) return null;
    const rel = relTo(cwd, raw);
    const label = matchShipBoundary(rel);
    return label ? { item: "boundary-path", label: `${toolName} ${rel} (${label})` } : null;
  }

  if (toolName !== "Bash") return null;
  const raw = typeof input.command === "string" ? input.command.trim() : "";
  if (!raw) return null;
  const command = withoutGitGlobalOptions(raw);

  for (const [re, label] of INTEGRATION) if (re.test(command)) return { item: "integration", label };
  const ci = classifyMeteredCiRisk(command);
  if (ci) return { item: "integration", label: ci.verb };
  for (const [re, label] of DISCARD) if (re.test(command)) return { item: "discard", label };
  if (args.treeMode !== "worktree") {
    const head = classifySharedTreeRisk(command);
    if (head) return { item: "containment", label: `${head.verb} in a shared checkout` };
  }
  for (const target of shellWriteTargets(command)) {
    const rel = relTo(cwd, target);
    const label = matchShipBoundary(rel);
    if (label) return { item: "boundary-path", label: `shell write to ${rel} (${label})` };
  }
  return null;
}
