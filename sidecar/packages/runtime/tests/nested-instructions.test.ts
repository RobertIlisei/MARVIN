import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { HookJSONOutput, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, describe, expect, it } from "vitest";

import { makeNestedInstructionsPostToolUse, resetNestedInstructions } from "../src/nested-instructions";

// ADR-0119 — a subdirectory's own CLAUDE.md / AGENTS.md reaches the model when
// work reaches that directory, as Claude Code and Codex both do. Since
// ADR-0118 isolated MARVIN from the SDK's project source, nothing did.

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marvin-nested-")));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const call = (tool: string, input: Record<string, unknown>) =>
  ({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: "", session_id: "s", transcript_path: "", cwd: "" }) as unknown as PostToolUseHookInput;

async function context(hook: ReturnType<typeof makeNestedInstructionsPostToolUse>, tool: string, input: Record<string, unknown>) {
  const out = (await hook(call(tool, input), undefined, { signal: new AbortController().signal })) as HookJSONOutput & {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return out.hookSpecificOutput?.additionalContext ?? "";
}

describe("nested instructions", () => {
  it("surfaces a subdirectory's instructions the first time work reaches it, and only then", async () => {
    const root = project({ "apps/api/CLAUDE.md": "API: annotation processor order is mandatory.", "apps/api/src/A.java": "" });
    const hook = makeNestedInstructionsPostToolUse({ sessionKey: "s1", cwd: root });
    const first = await context(hook, "Read", { file_path: join(root, "apps/api/src/A.java") });
    expect(first).toContain("annotation processor order is mandatory");
    expect(first).toContain("apps/api/CLAUDE.md");
    expect(await context(hook, "Edit", { file_path: join(root, "apps/api/src/A.java") })).toBe("");
  });

  it("surfaces them again after a compaction", async () => {
    const root = project({ "web/AGENTS.md": "Web: use the design tokens.", "web/x.ts": "" });
    const hook = makeNestedInstructionsPostToolUse({ sessionKey: "s2", cwd: root });
    await context(hook, "Read", { file_path: join(root, "web/x.ts") });
    resetNestedInstructions("s2");
    expect(await context(hook, "Read", { file_path: join(root, "web/x.ts") })).toContain("design tokens");
  });

  it("walks outer directories before inner ones and leaves the root to the project context", async () => {
    const root = project({ "CLAUDE.md": "ROOT", "a/CLAUDE.md": "OUTER", "a/b/AGENTS.md": "INNER", "a/b/f.ts": "" });
    const hook = makeNestedInstructionsPostToolUse({ sessionKey: "s3", cwd: root });
    const ctx = await context(hook, "Write", { file_path: join(root, "a/b/f.ts") });
    expect(ctx).not.toContain("ROOT");
    expect(ctx.indexOf("OUTER")).toBeLessThan(ctx.indexOf("INNER"));
  });

  it("never surfaces files under dependency, build, VCS or MARVIN directories", async () => {
    const root = project({
      "node_modules/pkg/AGENTS.md": "DEP", "node_modules/pkg/i.js": "",
      ".marvin/plugins-stage/p/AGENTS.md": "PLUGIN", ".marvin/plugins-stage/p/s.md": "",
    });
    const hook = makeNestedInstructionsPostToolUse({ sessionKey: "s4", cwd: root });
    expect(await context(hook, "Read", { file_path: join(root, "node_modules/pkg/i.js") })).toBe("");
    expect(await context(hook, "Read", { file_path: join(root, ".marvin/plugins-stage/p/s.md") })).toBe("");
  });

  it("ignores files outside the working directory and tools that touch no file", async () => {
    const root = project({ "x/CLAUDE.md": "X" });
    const elsewhere = project({ "y/CLAUDE.md": "Y", "y/f.ts": "" });
    const hook = makeNestedInstructionsPostToolUse({ sessionKey: "s5", cwd: root });
    expect(await context(hook, "Read", { file_path: join(elsewhere, "y/f.ts") })).toBe("");
    expect(await context(hook, "Bash", { command: "ls x" })).toBe("");
  });

  it("reads NotebookEdit's notebook_path and resolves relative paths against the cwd", async () => {
    const root = project({ "nb/CLAUDE.md": "NOTEBOOK RULES", "nb/a.ipynb": "{}", "rel/CLAUDE.md": "REL RULES", "rel/f.ts": "" });
    const hook = makeNestedInstructionsPostToolUse({ sessionKey: "s6", cwd: root });
    expect(await context(hook, "NotebookEdit", { notebook_path: join(root, "nb/a.ipynb") })).toContain("NOTEBOOK RULES");
    expect(await context(hook, "Read", { file_path: "rel/f.ts" })).toContain("REL RULES");
  });
});
