import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAutoModeLogger } from "../src/sdk-runner";

// ADR-0131 decision 3 — `.marvin/notices.json` joins the app-owned-path deny
// (with `.marvin/memory.md` and `.marvin/plans/`): a tab cannot write the
// project's notices with Edit, Write or a mutating shell command. Reads pass.

let workDir: string;
let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "marvin-notices-gate-"));
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-notices-gate-data-"));
  process.env.MARVIN_DATA_DIR = dataDir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(workDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const meta = { signal: new AbortController().signal, toolUseID: "t" } as never;
const target = () => path.join(workDir, ".marvin", "notices.json");

describe("a tab cannot write .marvin/notices.json", () => {
  it.each(["auto", "full"] as const)("%s: Edit, Write and a mutating Bash command are denied", async (strategy) => {
    const gate = makeAutoModeLogger({ cwd: workDir, workDir, turnId: `n-${strategy}`, permissionStrategy: strategy });
    expect((await gate("Write", { file_path: target(), content: "[]" }, meta))?.behavior).toBe("deny");
    expect((await gate("Edit", { file_path: target(), old_string: "a", new_string: "b" }, meta))?.behavior).toBe("deny");
    expect((await gate("Bash", { command: `echo '[]' > ${target()}` }, meta))?.behavior).toBe("deny");
    expect((await gate("Bash", { command: `sed -i '' 's/a/b/' .marvin/notices.json` }, meta))?.behavior).toBe("deny");
  });

  it("a read of the file, and a write to a neighbour, still pass", async () => {
    const gate = makeAutoModeLogger({ cwd: workDir, workDir, turnId: "n-read", permissionStrategy: "auto" });
    expect((await gate("Bash", { command: `cat ${target()}` }, meta))?.behavior).not.toBe("deny");
    expect((await gate("Write", { file_path: path.join(workDir, ".marvin", "session-notes.md"), content: "x" }, meta))?.behavior).not.toBe("deny");
  });
});
