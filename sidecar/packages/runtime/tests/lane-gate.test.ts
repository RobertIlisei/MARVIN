// ADR-0107 — ownership lanes for a tab in the SHARED checkout, through
// `makeAutoModeLogger` (the default callback whose contract is "never blocks
// on UI"). Pins: an edit inside the lane is untouched; outside it confirms
// (deny when no UI); a HEAD-moving git command confirms once a lane is
// declared even with no other live session; and a tab with NO lane keeps
// ADR-0102's behaviour exactly (no confirm without a co-tenant).

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePendingConfirm } from "../src/confirm-registry";
import { makeAutoModeLogger } from "../src/sdk-runner";

let root: string;
const opened: Array<{ toolUseId: string; toolName: string; reason: string }> = [];
const meta = (toolUseID: string, agentID?: string) => ({ toolUseID, ...(agentID ? { agentID } : {}) }) as never;

function decided<T>(result: T | null | undefined): T {
  expect(result).toBeTruthy();
  return result as T;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-lane-gate-")));
  mkdirSync(path.join(root, "src", "api"), { recursive: true });
  mkdirSync(path.join(root, "docs"), { recursive: true });
  opened.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function gate(lane: string[] | undefined, withUI = true) {
  return makeAutoModeLogger({
    cwd: root,
    workDir: root,
    sessionTree: lane ? { mode: "shared", lane } : { mode: "shared" },
    turnId: "turn-L",
    checkpoint: { projectId: "p", marvinSessionId: "session-L" },
    ...(withUI
      ? { onConfirmRequest: (req) => opened.push({ toolUseId: req.toolUseId, toolName: req.toolName, reason: req.reason ?? "" }) }
      : {}),
  });
}

describe("lane gate", () => {
  it("an edit inside the lane is untouched; outside it confirms and names the lane", async () => {
    const g = gate(["src/api", "docs"]);
    const ok = decided(await g("Edit", { file_path: path.join(root, "src", "api", "a.ts"), old_string: "a", new_string: "b" }, meta("u1")));
    expect(ok.behavior).toBe("allow");
    expect(opened).toEqual([]);

    const pending = g("Write", { file_path: path.join(root, "src", "web", "b.ts"), content: "x" }, meta("u2"));
    await new Promise((r) => setTimeout(r, 10));
    expect(opened.map((o) => [o.toolUseId, o.toolName])).toEqual([["u2", "Write"]]);
    expect(opened[0]?.reason).toContain("src/api, docs");
    resolvePendingConfirm("turn-L", "u2", { behavior: "allow", updatedInput: {} });
    expect(decided(await pending).behavior).toBe("allow");
  });

  it("denies rather than runs when no UI is attached", async () => {
    const g = gate(["src/api"], false);
    const r = decided(await g("Edit", { file_path: path.join(root, "docs", "x.md"), old_string: "a", new_string: "b" }, meta("u3")));
    expect(r.behavior).toBe("deny");
  });

  it("a HEAD-moving git command confirms when a lane is declared, with no other session live", async () => {
    const g = gate(["src/api"]);
    const pending = g("Bash", { command: "git checkout -b feature" }, meta("u4"));
    await new Promise((r) => setTimeout(r, 10));
    expect(opened.map((o) => o.toolUseId)).toEqual(["u4"]);
    expect(opened[0]?.reason).toMatch(/lane/);
    resolvePendingConfirm("turn-L", "u4", { behavior: "deny", message: "no", interrupt: false });
    expect(decided(await pending).behavior).toBe("deny");
  });

  it("no lane → ADR-0102 unchanged: no confirm without a co-tenant, edits anywhere", async () => {
    const g = gate(undefined);
    expect(decided(await g("Bash", { command: "git checkout -b feature" }, meta("u5"))).behavior).toBe("allow");
    expect(decided(await g("Edit", { file_path: path.join(root, "docs", "x.md"), old_string: "a", new_string: "b" }, meta("u6"))).behavior).toBe("allow");
    expect(opened).toEqual([]);
  });

  it("paths outside the checkout and subagent calls are not the lane's business", async () => {
    const g = gate(["src/api"]);
    const outside = decided(await g("Write", { file_path: "/tmp/marvin-lane-outside.txt", content: "x" }, meta("u7")));
    expect(outside.behavior).not.toBe("deny");
    const sub = decided(await g("Edit", { file_path: path.join(root, "docs", "x.md"), old_string: "a", new_string: "b" }, meta("u8", "agent-1")));
    expect((sub as { message?: string }).message ?? "").not.toMatch(/lane/);
    expect(opened).toEqual([]);
  });
});
