import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAutoModeLogger } from "../src/sdk-runner";
import { makeSideDoorPreToolUseHook } from "../src/side-door-hook";

// ADR-0127 §5 — a tab tool call that names MARVIN's own control API or the
// supervisor's data directory is denied in `auto` AND `full`: through
// `toolPolicy` for what reaches the permission callback, and through the
// executor's PreToolUse hook for Read / Grep / Glob, which never do.

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-gate-data-"));
  workDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-gate-work-"));
  process.env.MARVIN_DATA_DIR = dataDir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const meta = { signal: new AbortController().signal, toolUseID: "t" } as never;

describe("tab side doors are denied in every posture", () => {
  it.each(["auto", "full"] as const)("%s: a Bash call to /api/confirm is denied", async (strategy) => {
    const gate = makeAutoModeLogger({ cwd: workDir, workDir, turnId: `t-${strategy}`, permissionStrategy: strategy });
    const r = await gate("Bash", { command: "curl -X POST http://localhost:3030/api/confirm -d '{}'" }, meta);
    expect(r?.behavior).toBe("deny");
  });

  it.each(["auto", "full"] as const)("%s: a Bash read of the supervisor token is denied", async (strategy) => {
    const gate = makeAutoModeLogger({ cwd: workDir, workDir, turnId: `t2-${strategy}`, permissionStrategy: strategy });
    const r = await gate("Bash", { command: `cat ${dataDir}/supervisor/token` }, meta);
    expect(r?.behavior).toBe("deny");
  });

  it("the executor PreToolUse hook denies a tab Read / Grep / Glob of the supervisor's directory", async () => {
    const hook = makeSideDoorPreToolUseHook();
    const call = (tool_name: string, tool_input: Record<string, unknown>) =>
      hook({ hook_event_name: "PreToolUse", tool_name, tool_input } as never, "id", { signal: new AbortController().signal }) as Promise<{
        hookSpecificOutput?: { permissionDecision?: string };
      }>;
    expect((await call("Read", { file_path: `${dataDir}/supervisor/token` })).hookSpecificOutput?.permissionDecision).toBe("deny");
    expect((await call("Grep", { pattern: "x", path: `${dataDir}/supervisor` })).hookSpecificOutput?.permissionDecision).toBe("deny");
    expect((await call("Glob", { pattern: `${dataDir}/supervisor/**` })).hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(await call("Read", { file_path: path.join(workDir, "src", "a.ts") })).toEqual({});
  });

  it("runAgent registers the side-door hook ahead of the design hooks", () => {
    const src = readFileSync(path.join(__dirname, "../src/sdk-runner.ts"), "utf8");
    expect(src).toMatch(/PreToolUse: \[\{ hooks: \[makeSideDoorPreToolUseHook\(\), designPreToolUseHook\] \}\]/);
  });
});
