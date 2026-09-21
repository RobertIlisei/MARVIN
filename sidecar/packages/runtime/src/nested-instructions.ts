/**
 * ADR-0119 — a subdirectory's own instruction files reach the model when work
 * reaches that directory.
 *
 * Claude Code loads `apps/api/CLAUDE.md` when it reads a file under
 * `apps/api/`; Codex does the same with `AGENTS.md`. MARVIN had that for free
 * through the SDK's project settings source until ADR-0118 isolated it from
 * that source (the source also carried the user's plugins and hooks), and from
 * then on nested instructions reached nobody. This PostToolUse hook restores
 * the behaviour on MARVIN's side: after a Read / Edit / Write / NotebookEdit,
 * each directory between the working directory and the file that has
 * instruction files is surfaced once per session — outer first — through the
 * same resolver as the root (`resolveInstructionFiles`). The root itself is
 * the project context's job. Dependency, build, VCS and `.marvin/` directories
 * never count: their instruction files belong to someone else's project.
 */
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { HookCallback, HookJSONOutput, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { resolveInstructionFiles } from "@marvin/project-context/instruction-files";
import { IGNORE_DIR_NAMES, MARVIN_DIR } from "@marvin/tools/fs-constants";

/** Directories already considered, per session. */
const surfaced = new Map<string, Set<string>>();

/** Forget what was surfaced — after a compaction the context no longer holds it. */
export function resetNestedInstructions(sessionKey: string): void {
  surfaced.delete(sessionKey);
}

function targetPath(tool: string, input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>;
  if (tool === "Read" || tool === "Edit" || tool === "Write") return typeof i.file_path === "string" ? i.file_path : null;
  if (tool === "NotebookEdit") return typeof i.notebook_path === "string" ? i.notebook_path : null;
  return null;
}

/** Directories strictly between `cwd` and the file's directory, outermost first. */
function candidateDirs(file: string, cwd: string): string[] {
  const rel = relative(cwd, resolve(cwd, file));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return [];
  const parts = rel.split(sep).slice(0, -1);
  if (parts.some((p) => IGNORE_DIR_NAMES.has(p) || p === MARVIN_DIR)) return [];
  return parts.map((_, i) => join(cwd, ...parts.slice(0, i + 1)));
}

export function makeNestedInstructionsPostToolUse(args: { sessionKey: string; cwd: string }): HookCallback {
  const { sessionKey, cwd } = args;
  return async (input) => {
    if (input.hook_event_name !== "PostToolUse") return {} as HookJSONOutput;
    const evt = input as PostToolUseHookInput;
    const file = targetPath(evt.tool_name, evt.tool_input);
    if (!file) return {} as HookJSONOutput;

    let seen = surfaced.get(sessionKey);
    if (!seen) {
      seen = new Set();
      surfaced.set(sessionKey, seen);
    }
    const blocks: string[] = [];
    for (const dir of candidateDirs(file, cwd)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const resolved = resolveInstructionFiles(dir, cwd);
      for (const s of resolved.sections) {
        blocks.push(
          `[Instructions for \`${relative(cwd, dir)}/\` from \`${relative(cwd, s.path)}\` — they apply to work in this directory]\n\n${s.text.trim()}`,
        );
      }
    }
    if (blocks.length === 0) return {} as HookJSONOutput;
    return {
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: blocks.join("\n\n") },
    } as HookJSONOutput;
  };
}
