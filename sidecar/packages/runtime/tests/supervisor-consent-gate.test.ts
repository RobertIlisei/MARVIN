import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { answerQuestion } from "../src/confirm-answer";
import { clearTurnConfirms, getPendingConfirm, registerPendingConfirm, resolvePendingConfirm } from "../src/confirm-registry";
import { type AgentMode, makeAutoModeLogger, makeGatedCanUseTool, makeLivePostureGate, type PermissionStrategy } from "../src/sdk-runner";
import type { SessionTree } from "../src/session-meta";
import { isUserOnlyConfirm, markTurnTouched, resetTouchesForTests } from "../src/supervisor-touch";
import { endLiveTurn, type LiveTurn, registerLiveTurn } from "../src/turn-registry";

// ADR-0127 §5 — inside a supervisor-touched turn every §4 act raises a confirm
// only the user can answer, in every posture (`full` included), for the
// containment confirms `full` waives too. Exercised through the real gates.

let dataDir: string;
let workDir: string;
let turn: LiveTurn | null = null;
const prev = process.env.MARVIN_DATA_DIR;
const cards: Array<{ toolName: string; toolUseId: string; reason: string }> = [];
const TURN = "turn-cg";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-cg-data-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-cg-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  cards.length = 0;
  resetTouchesForTests();
  turn = registerLiveTurn({ turnId: TURN, marvinSessionId: "tab-cg", projectId: "proj" });
});
afterEach(() => {
  clearTurnConfirms(TURN);
  if (turn) endLiveTurn(turn, { event: "turn.completed", data: {} });
  turn = null;
  resetTouchesForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const opts = (id: string, agentID?: string) => ({ toolUseID: id, signal: new AbortController().signal, ...(agentID ? { agentID } : {}) }) as never;
const touch = (by: "message" | "answer" = "message") => markTurnTouched({ projectId: "proj", marvinSessionId: "tab-cg", turnId: TURN, by });

/** The construction runAgent uses, for a tab in `tree`. */
function gate(strategy: PermissionStrategy, mode: AgentMode = "agent", tree: SessionTree = { mode: "shared" }, opts2: { ui?: boolean } = {}) {
  const ui = opts2.ui ?? true;
  const onConfirmRequest = ui
    ? (req: { toolName: string; toolUseId: string; reason?: string }) => {
        cards.push({ toolName: req.toolName, toolUseId: req.toolUseId, reason: req.reason ?? "" });
      }
    : undefined;
  const cwd = tree.mode === "worktree" ? tree.path : workDir;
  const gateFor = (s: PermissionStrategy, m: AgentMode) => {
    const readOnly = m === "ask" || m === "plan";
    return s === "gated"
      ? makeGatedCanUseTool({ cwd, workDir, sessionTree: tree, turnId: TURN, readOnly, mode: m, ...(onConfirmRequest ? { onConfirmRequest } : {}) } as never)
      : makeAutoModeLogger({ cwd, workDir, sessionTree: tree, turnId: TURN, readOnly, mode: m, permissionStrategy: s, ...(onConfirmRequest ? { onConfirmRequest } : {}) });
  };
  return makeLivePostureGate({ turnId: TURN, permissionStrategy: strategy, mode, gateFor, consent: { cwd, treeMode: tree.mode, ...(onConfirmRequest ? { onConfirmRequest } : {}) } });
}

const settle = () => new Promise((r) => setTimeout(r, 20));

/** Run a call; report whether it is waiting on a user-only card. */
async function probe(g: ReturnType<typeof gate>, toolName: string, input: Record<string, unknown>, id: string, agentID?: string) {
  let result: { behavior: string } | undefined;
  void Promise.resolve(g(toolName, input, opts(id, agentID))).then((r) => {
    result = r as { behavior: string };
  });
  await settle();
  const pending = getPendingConfirm(TURN, id);
  return { result, raisedBy: pending?.raisedBy ?? null, userOnly: pending ? isUserOnlyConfirm(TURN, id) : false };
}

const ACTS: Array<[string, string, Record<string, unknown>]> = [
  ["git push", "Bash", { command: "git push origin marvin/tab/x" }],
  ["a merge request", "Bash", { command: "glab mr create --fill" }],
  ["an .env edit", "Edit", { file_path: ".env", old_string: "A=1", new_string: "A=2" }],
  ["a HEAD-moving command (ADR-0102)", "Bash", { command: "git checkout main" }],
];

describe("a supervisor-started turn: §4 acts are the user's, in auto and in full", () => {
  for (const strategy of ["auto", "full", "gated"] as const) {
    it.each(ACTS)(`%s raises a user-only confirm in ${strategy}`, async (_name, toolName, input) => {
      touch("message");
      const p = await probe(gate(strategy), toolName, input, `${strategy}-${toolName}`);
      expect(p.raisedBy).toBe("supervisor-touched");
      expect(p.userOnly).toBe(true);
      expect(p.result).toBeUndefined(); // waiting on the user
      expect(cards.at(-1)?.reason).toMatch(/supervisor/i);
    });
  }
});

describe("a user-started turn after the supervisor answered a question in it", () => {
  it.each(ACTS)("%s raises a user-only confirm in full", async (_name, toolName, input) => {
    registerPendingConfirm(TURN, "q1", () => {}, { questions: [{ question: "Go on?", options: [{ label: "Yes" }] }] }, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
    expect(answerQuestion({ turnId: TURN, toolUseId: "q1", answers: { "Go on?": "Yes" }, other: {}, answeredBy: "supervisor" }).ok).toBe(true);
    const p = await probe(gate("full"), toolName, input, `ans-${toolName}`);
    expect(p.raisedBy).toBe("supervisor-touched");
    expect(p.userOnly).toBe(true);
  });
});

describe("what the user's consent leads to", () => {
  it("the user's allow runs the call through the ordinary gate (auto), never a second gated card", async () => {
    touch();
    let result: { behavior: string } | undefined;
    void Promise.resolve(gate("gated")("Bash", { command: "git push origin x" }, opts("push-1"))).then((r) => {
      result = r as { behavior: string };
    });
    await settle();
    expect(resolvePendingConfirm(TURN, "push-1", { behavior: "allow", updatedInput: { command: "git push origin x" } })).toBe(true);
    await settle();
    expect(cards).toHaveLength(1);
    expect(result?.behavior).toBeDefined();
  });

  it("the user's deny is final", async () => {
    touch();
    let result: { behavior: string } | undefined;
    void Promise.resolve(gate("full")("Bash", { command: "git push" }, opts("push-2"))).then((r) => {
      result = r as { behavior: string };
    });
    await settle();
    resolvePendingConfirm(TURN, "push-2", { behavior: "deny", message: "no", interrupt: false });
    await settle();
    expect(result?.behavior).toBe("deny");
  });

  it("with no UI attached the act is denied rather than run unattended", async () => {
    touch();
    const r = (await gate("full", "agent", { mode: "shared" }, { ui: false })("Bash", { command: "git push" }, opts("push-3"))) as { behavior: string; message?: string };
    expect(r.behavior).toBe("deny");
    expect(r.message).toMatch(/supervisor/i);
  });
});

describe("containment `full` waives comes back in a touched turn", () => {
  const wtTree = (): SessionTree => {
    const wt = path.join(workDir, ".marvin", "worktrees", "tab-cg");
    mkdirSync(wt, { recursive: true });
    return { mode: "worktree", slug: "tab-cg", path: wt, branch: "marvin/tab/cg", base: "main" };
  };

  it("a worktree tab's shell command against the main checkout raises the session-worktree confirm, and it is the user's", async () => {
    const tree = wtTree();
    touch();
    const p = await probe(gate("full", "agent", tree), "Bash", { command: `cp notes.txt ${path.join(workDir, "src")}/` }, "wt-1");
    expect(p.raisedBy).toBe("session-worktree");
    expect(p.userOnly).toBe(true);
  });

  it("a worktree tab's Edit into the main checkout is denied outright, as in auto", async () => {
    const tree = wtTree();
    touch();
    const p = await probe(gate("full", "agent", tree), "Edit", { file_path: path.join(workDir, "src", "a.ts"), old_string: "a", new_string: "b" }, "wt-2");
    expect(p.result?.behavior).toBe("deny");
  });

  it("untouched, `full` waives both as before (regression)", async () => {
    const tree = wtTree();
    const p = await probe(gate("full", "agent", tree), "Bash", { command: `cp notes.txt ${path.join(workDir, "src")}/` }, "wt-3");
    expect(p.raisedBy).toBeNull();
    const e = await probe(gate("full", "agent", tree), "Edit", { file_path: path.join(workDir, "src", "a.ts"), old_string: "a", new_string: "b" }, "wt-4");
    expect(e.result?.behavior).toBe("allow");
  });
});

describe("what the touched gate leaves alone", () => {
  it("a subagent's push inside a touched turn is gated too (an implementer may push)", async () => {
    touch();
    const p = await probe(gate("full"), "Bash", { command: "git push" }, "sub-1", "agent-impl");
    expect(p.raisedBy).toBe("supervisor-touched");
  });

  it("ordinary work in a touched turn raises nothing", async () => {
    touch();
    const p = await probe(gate("auto"), "Edit", { file_path: path.join(workDir, "src", "flags.ts"), old_string: "a", new_string: "b" }, "ok-1");
    expect(p.raisedBy).toBeNull();
    expect(p.result?.behavior).toBe("allow");
  });

  it("an untouched turn raises no supervisor card for the same acts (regression)", async () => {
    const p = await probe(gate("full"), "Edit", { file_path: ".env", old_string: "A=1", new_string: "A=2" }, "un-1");
    expect(p.raisedBy).not.toBe("supervisor-touched");
  });

  it("in Ask mode the read-only gate denies the act outright; there is nothing to consent to", async () => {
    touch();
    const p = await probe(gate("auto", "ask"), "Bash", { command: "git push" }, "ask-1");
    expect(p.raisedBy).toBeNull();
    expect(p.result?.behavior).toBe("deny");
  });
});

describe("the turn-close hook treats a supervisor-authored turn as a machine turn", () => {
  it("the envelope's first line matches the hook's machine-turn test", async () => {
    const { readFileSync } = await import("node:fs");
    const { supervisorEnvelope } = await import("../src/supervisor-send");
    const src = readFileSync(path.join(__dirname, "../src/sdk-runner.ts"), "utf8");
    const m = /machineTurn: (\/.+\/)\.test\(message\)/.exec(src);
    expect(m).not.toBeNull();
    const re = new Function(`return ${m?.[1]}`)() as RegExp;
    expect(re.test(supervisorEnvelope("go on", "nudge"))).toBe(true);
  });
});
