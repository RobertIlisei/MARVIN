import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAutoModeLogger, skipsContainmentConfirms } from "../src/sdk-runner";

// ADR-0115 — `full` is what a person means by "skip permissions". `auto` had
// accumulated four confirm-raising rules since ADR-0015, so its own promise of
// behaving "like --dangerously-skip-permissions" had stopped being true.
//
// These pin what `full` waives and — more importantly — what it does not:
// metered CI, because it is the only confirm that spends money, and the
// hard-deny floor, because a subagent that may never write is an invariant the
// rest of MARVIN is built on rather than a preference.

let root: string;
let wt: string;
const opened: Array<{ toolName: string; reason: string }> = [];
const meta = (toolUseID: string, agentID?: string) =>
  ({ toolUseID, ...(agentID ? { agentID } : {}) }) as never;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-full-auto-")));
  wt = path.join(root, ".marvin", "worktrees", "tab-x");
  mkdirSync(wt, { recursive: true });
  opened.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function gate(strategy: "auto" | "full", tree: "worktree" | "shared" = "worktree") {
  return makeAutoModeLogger({
    cwd: tree === "worktree" ? wt : root,
    workDir: root,
    sessionTree: tree === "worktree"
      ? { mode: "worktree", slug: "x", path: wt, branch: "marvin/tab/x", base: "abc" }
      : { mode: "shared" },
    turnId: "turn-F",
    permissionStrategy: strategy,
    checkpoint: { projectId: "p", marvinSessionId: "session-F" },
    onConfirmRequest: (req) => {
      opened.push({ toolName: req.toolName, reason: req.reason ?? "" });
      // Never resolved: a confirm that is raised is the thing under test, and
      // awaiting it would hang the case.
      return new Promise(() => {}) as never;
    },
  });
}

describe("permission strategy: full", () => {
  it("names itself, and nothing else waives containment", () => {
    expect(skipsContainmentConfirms("full")).toBe(true);
    expect(skipsContainmentConfirms("auto")).toBe(false);
    expect(skipsContainmentConfirms("gated")).toBe(false);
  });

  it("auto still confirms a command that names the main checkout; full does not", async () => {
    // A write into the main checkout from an isolated tab — the shape
    // addendum 5 kept confirming after reads were let through.
    const cmd = { command: `echo hi > ${root}/notes.md` };

    // Auto: the containment confirm opens and the call waits on it.
    const autoGate = gate("auto");
    let settled = false;
    void autoGate("Bash", cmd, meta("t1")).then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(opened.map((o) => o.toolName)).toEqual(["Bash"]);
    expect(opened[0]?.reason).toMatch(/checkout/i);
    expect(settled).toBe(false);

    // Full: no confirm, and the call is decided rather than parked.
    opened.length = 0;
    const res = await gate("full")("Bash", cmd, meta("t2"));
    expect(opened).toEqual([]);
    expect(res?.behavior).toBe("allow");
  });

  it("full still stops at the hard-deny floor: a subagent may not write", async () => {
    // ADR-0030 — the invariant the whitepaper's Bet 1 rests on. A mode that
    // suspended it would make MARVIN's own guarantee untrue while it was on.
    const res = await gate("full")("Write", { file_path: path.join(wt, "x.ts"), content: "x" }, meta("t3", "implementer-1"));
    expect(res?.behavior).toBe("deny");
    expect(opened).toEqual([]);
  });

  it("full still refuses background execution", async () => {
    // ADR-0038 — `&` and `nohup` are denied at the gate because a job that
    // outlives its turn has no one left to report to.
    const res = await gate("full")("Bash", { command: "npm run build &" }, meta("t4"));
    expect(res?.behavior).toBe("deny");
  });

  it("full still asks before spending CI minutes", async () => {
    // ADR-0109, decided with the user 2026-09-11: the one confirm that costs
    // money keeps its confirm in every mode, including this one. On a SHARED
    // tab — a worktree tab's branch is never published by MARVIN at all
    // (2026-09-12 amendment), which is a deny, tested below.
    void gate("full", "shared")("Bash", { command: "glab mr create --fill" }, meta("t5"));
    await new Promise((r) => setTimeout(r, 20));
    expect(opened.map((o) => o.toolName)).toEqual(["Bash"]);
    expect(opened[0]?.reason.toLowerCase()).toMatch(/pipeline|ci|merge request/);
  });

  it("full denies a request from a worktree tab outright — no card, the local path named", async () => {
    const res = await gate("full")("Bash", { command: "glab mr create --fill" }, meta("t5b"));
    expect(res?.behavior).toBe("deny");
    expect(opened).toEqual([]);
  });

  it("full still lets the model ask its own question", async () => {
    // AskUserQuestion is not a permission — it is the model asking. Suppressing
    // it leaves the turn waiting on an answer that never arrives (ADR-0040).
    void gate("full")("AskUserQuestion", { questions: [{ question: "which?", header: "h", options: [] }] }, meta("t6"));
    await new Promise((r) => setTimeout(r, 20));
    expect(opened.map((o) => o.toolName)).toEqual(["AskUserQuestion"]);
  });
});
