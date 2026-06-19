import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Disable the confirm-registry auto-deny timer so the gated-mode test
// that asserts "Promise stays pending until resolvePendingConfirm
// fires" doesn't race the 5-minute fallback. Must be set before
// importing the registry.
process.env.MARVIN_CONFIRM_TIMEOUT_MS = "0";

import {
  clearTurnConfirms,
  resolvePendingConfirm,
} from "../src/confirm-registry";
import {
  type ConfirmRequestPayload,
  classifyToolCall,
  makeAutoModeLogger,
  makeGatedCanUseTool,
} from "../src/sdk-runner";

// These tests pin the dispatch contract that ADR-0015 §1 codifies:
//
//   1. `auto` mode and `gated` mode both run the SAME classifier
//      (`classifyToolCall`) — there is no second policy hidden in one
//      of the closures.
//   2. Hard-deny patterns deny in BOTH modes (single safety floor).
//   3. `auto` mode allows everything else and writes one JSONL line per
//      mutating tool to `<cwd>/.marvin/auto-audit.jsonl`. It NEVER
//      registers a pending confirm Promise — the user-experience
//      contract is "no UI prompts in auto mode".
//   4. `gated` mode auto-class allows + audits, confirm-class registers
//      a Promise + emits `onConfirmRequest`, deny-class denies.
//
// The factories are exported precisely so we can pin them here without
// spinning up a full `runAgent` SDK loop. If you change the dispatch
// shape, update the test — but a silent regression should never ship.

let tmpRoot: string;

beforeAll(() => {
  // Vitest's `isolate: false` means env mutations persist between
  // tests in the same file — that's what we want for the registry
  // timeout above.
});

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "marvin-can-use-tool-"));
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

const TURN_ID = "turn_test_001";
const TOOL_USE_ID = "toolu_test_001";
const SDK_CTX = {
  signal: new AbortController().signal,
  suggestions: [],
  toolUseID: TOOL_USE_ID,
} as const;

function readAuditLines(cwd: string): unknown[] {
  const p = path.join(cwd, ".marvin", "auto-audit.jsonl");
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe("classifyToolCall", () => {
  it("allows Read (auto-class)", () => {
    const r = classifyToolCall("Read", { file_path: "/tmp/x" });
    expect(r.decision).toBe("allow");
  });

  it("denies hard-deny Bash (rm -rf /)", () => {
    const r = classifyToolCall("Bash", { command: "rm -rf /" });
    expect(r.decision).toBe("deny");
  });

  it("denies hard-deny Bash (git push --force)", () => {
    const r = classifyToolCall("Bash", { command: "git push --force origin main" });
    expect(r.decision).toBe("deny");
  });

  it("confirms Edit (mutator)", () => {
    const r = classifyToolCall("Edit", { file_path: "/tmp/x", old_string: "a", new_string: "b" });
    expect(r.decision).toBe("confirm");
  });

  it("confirms a Bash command not in auto-allow", () => {
    const r = classifyToolCall("Bash", { command: "npm install some-pkg" });
    expect(r.decision).toBe("confirm");
  });

  it("allows tools outside the gated set (Task, MCP, etc.)", () => {
    const r = classifyToolCall("mcp__some_server__some_tool", {});
    expect(r.decision).toBe("allow");
  });
});

// ADR-0030 — the sub-agent read-only invariant. When a tool call
// originates inside a sub-agent (the SDK passes its `agentID`), no
// workspace mutation is permitted: confirm-class and deny-class both
// collapse to deny, while read-only / whitelisted tools still allow.
// This is the ONLY tool-layer control over dynamic-workflow children,
// which the Claude binary spawns without a MARVIN-controlled agent
// definition. Golden Rule 1 — sub-agents are bounded and read-only.
describe("classifyToolCall — sub-agent read-only invariant (ADR-0030)", () => {
  const sub = { agentID: "agent_workflow_child_1" };

  it("still ALLOWS read-only tools from a sub-agent", () => {
    expect(classifyToolCall("Read", { file_path: "/tmp/x" }, sub).decision).toBe("allow");
    expect(classifyToolCall("Grep", { pattern: "foo" }, sub).decision).toBe("allow");
    expect(classifyToolCall("Glob", { pattern: "**/*.ts" }, sub).decision).toBe("allow");
  });

  it("DENIES Write/Edit/NotebookEdit from a sub-agent (would otherwise confirm)", () => {
    const w = classifyToolCall("Write", { file_path: "/tmp/x", content: "y" }, sub);
    const e = classifyToolCall("Edit", { file_path: "/tmp/x", old_string: "a", new_string: "b" }, sub);
    expect(w.decision).toBe("deny");
    expect(e.decision).toBe("deny");
    expect(w.reason).toMatch(/sub-agent/i);
    expect(w.reason).toMatch(/ADR-0030|Golden Rule 1/);
  });

  it("DENIES otherwise-confirm Bash from a sub-agent", () => {
    const r = classifyToolCall("Bash", { command: "npm install some-pkg" }, sub);
    expect(r.decision).toBe("deny");
  });

  it("still DENIES hard-deny Bash from a sub-agent (floor unchanged)", () => {
    expect(classifyToolCall("Bash", { command: "rm -rf /" }, sub).decision).toBe("deny");
  });

  it("does NOT change behaviour for main-loop calls (no agentID)", () => {
    // Same calls without agentID keep their normal classification.
    expect(classifyToolCall("Write", { file_path: "/tmp/x", content: "y" }).decision).toBe("confirm");
    expect(classifyToolCall("Read", { file_path: "/tmp/x" }).decision).toBe("allow");
  });
});

// ADR-0045 — the Playwright MCP server is gated (not blanket-allowed like the
// trusted in-process servers). Observational tools auto-run; state-changing /
// egress tools confirm; the arbitrary-code tool is denied; and the sub-agent
// invariant collapses confirm/deny → deny so a scout gets a read-only browser.
describe("classifyToolCall — Playwright MCP gating (ADR-0045)", () => {
  const pw = (t: string) => `mcp__playwright__${t}`;

  it("auto-allows observational browser tools", () => {
    expect(classifyToolCall(pw("browser_snapshot"), {}).decision).toBe("allow");
    expect(classifyToolCall(pw("browser_take_screenshot"), {}).decision).toBe("allow");
    expect(classifyToolCall(pw("browser_network_requests"), {}).decision).toBe("allow");
  });

  it("confirms state-changing / egress browser tools", () => {
    expect(classifyToolCall(pw("browser_navigate"), { url: "http://x" }).decision).toBe("confirm");
    expect(classifyToolCall(pw("browser_click"), {}).decision).toBe("confirm");
    expect(classifyToolCall(pw("browser_evaluate"), { function: "()=>1" }).decision).toBe("confirm");
  });

  it("DENIES the arbitrary-code tool", () => {
    const r = classifyToolCall(pw("browser_run_code_unsafe"), {});
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/ADR-0045/);
  });

  it("leaves trusted in-process MCP servers blanket-allowed", () => {
    expect(classifyToolCall("mcp__marvin-graph__graph_search", {}).decision).toBe("allow");
    expect(classifyToolCall("mcp__marvin-backlog__backlog_add", {}).decision).toBe("allow");
  });

  it("collapses to read-only for a sub-agent (scout gets snapshot, not click/code)", () => {
    const sub = { agentID: "agent_scout_1" };
    expect(classifyToolCall(pw("browser_snapshot"), {}, sub).decision).toBe("allow");
    expect(classifyToolCall(pw("browser_click"), {}, sub).decision).toBe("deny");
    expect(classifyToolCall(pw("browser_evaluate"), {}, sub).decision).toBe("deny");
    expect(classifyToolCall(pw("browser_run_code_unsafe"), {}, sub).decision).toBe("deny");
  });
});

describe("makeAutoModeLogger (auto mode)", () => {
  it("denies hard-deny patterns even in auto mode (single safety floor)", async () => {
    const logger = makeAutoModeLogger({ cwd: tmpRoot, turnId: TURN_ID });
    const result = await logger("Bash", { command: "rm -rf /" }, SDK_CTX);
    expect(result.behavior).toBe("deny");
    // No audit line is written for denied calls — the SDK never ran.
    expect(readAuditLines(tmpRoot)).toEqual([]);
  });

  it("allows + audits a confirm-class call (auto-mode bypass)", async () => {
    const logger = makeAutoModeLogger({ cwd: tmpRoot, turnId: TURN_ID });
    const result = await logger(
      "Edit",
      { file_path: `${tmpRoot}/foo.ts`, old_string: "a", new_string: "b" },
      SDK_CTX,
    );
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedInput).toEqual({
        file_path: `${tmpRoot}/foo.ts`,
        old_string: "a",
        new_string: "b",
      });
    }
    const lines = readAuditLines(tmpRoot) as Array<{ tool: string; reason: string; descriptor: string; turnId: string }>;
    expect(lines).toHaveLength(1);
    expect(lines[0]?.tool).toBe("Edit");
    // The "auto-mode bypass" prefix is the tag that lets users (and
    // future audits) tell which entries fired only because the user
    // opted into `auto` — the user-visible signal that gated mode
    // would have prompted.
    expect(lines[0]?.reason).toMatch(/^auto-mode bypass:/);
    expect(lines[0]?.turnId).toBe(TURN_ID);
  });

  it("allows + audits an auto-class mutating call without the bypass prefix", async () => {
    const logger = makeAutoModeLogger({ cwd: tmpRoot, turnId: TURN_ID });
    // `git status` is in BASH_AUTO_ALLOW — auto-class even in gated mode.
    const result = await logger("Bash", { command: "git status" }, SDK_CTX);
    expect(result.behavior).toBe("allow");
    const lines = readAuditLines(tmpRoot) as Array<{ tool: string; reason: string }>;
    expect(lines).toHaveLength(1);
    expect(lines[0]?.tool).toBe("Bash");
    // Auto-class lines carry the policy reason verbatim — no "bypass"
    // tag because the gated path would have allowed too.
    expect(lines[0]?.reason).not.toMatch(/^auto-mode bypass:/);
  });

  it("does not audit Read (read-only tools fall through TOOLS_WORTH_LOGGING)", async () => {
    const logger = makeAutoModeLogger({ cwd: tmpRoot, turnId: TURN_ID });
    await logger("Read", { file_path: `${tmpRoot}/x.ts` }, SDK_CTX);
    expect(readAuditLines(tmpRoot)).toEqual([]);
  });

  it("normalises undefined toolInput to {}", async () => {
    const logger = makeAutoModeLogger({ cwd: tmpRoot, turnId: TURN_ID });
    const result = await logger("Read", undefined as unknown as Record<string, unknown>, SDK_CTX);
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedInput).toEqual({});
    }
  });
});

describe("makeGatedCanUseTool (gated mode)", () => {
  it("denies hard-deny patterns", async () => {
    const seen: ConfirmRequestPayload[] = [];
    const gate = makeGatedCanUseTool({
      cwd: tmpRoot,
      turnId: TURN_ID,
      onConfirmRequest: (r) => seen.push(r),
    });
    const result = await gate("Bash", { command: "rm -rf $HOME/important" }, SDK_CTX);
    expect(result.behavior).toBe("deny");
    // Hard-deny short-circuits — no confirm card is rendered.
    expect(seen).toEqual([]);
    expect(readAuditLines(tmpRoot)).toEqual([]);
  });

  it("auto-allows + audits an auto-class call without prompting the user", async () => {
    const seen: ConfirmRequestPayload[] = [];
    const gate = makeGatedCanUseTool({
      cwd: tmpRoot,
      turnId: TURN_ID,
      onConfirmRequest: (r) => seen.push(r),
    });
    const result = await gate("Bash", { command: "git status" }, SDK_CTX);
    expect(result.behavior).toBe("allow");
    expect(seen).toEqual([]);
    const lines = readAuditLines(tmpRoot) as Array<{ tool: string }>;
    expect(lines).toHaveLength(1);
    expect(lines[0]?.tool).toBe("Bash");
  });

  it("registers a pending confirm and emits onConfirmRequest for confirm-class calls", async () => {
    const seen: ConfirmRequestPayload[] = [];
    const gate = makeGatedCanUseTool({
      cwd: tmpRoot,
      turnId: TURN_ID,
      onConfirmRequest: (r) => seen.push(r),
    });

    const promise = gate(
      "Edit",
      { file_path: `${tmpRoot}/foo.ts`, old_string: "a", new_string: "b" },
      SDK_CTX,
    );

    // The Promise must be pending — the gate is awaiting the user's
    // click. If this assertion fires synchronously, gated mode is
    // running the auto-mode bypass (regression).
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // The UI got exactly one confirm request with the policy reason
    // and tool input intact.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.toolName).toBe("Edit");
    expect(seen[0]?.turnId).toBe(TURN_ID);
    expect(seen[0]?.toolUseId).toBe(TOOL_USE_ID);
    expect(seen[0]?.input).toEqual({
      file_path: `${tmpRoot}/foo.ts`,
      old_string: "a",
      new_string: "b",
    });

    // The /api/confirm handler resolves the registry; the gate's
    // Promise resolves with the user's verdict.
    resolvePendingConfirm(TURN_ID, TOOL_USE_ID, {
      behavior: "allow",
      updatedInput: { file_path: `${tmpRoot}/foo.ts`, old_string: "a", new_string: "b" },
    });
    const result = await promise;
    expect(result.behavior).toBe("allow");

    // No audit line until the user opts in — the audit log records
    // what fired, and a pending confirm has not fired yet. (In gated
    // mode, the audit append happens on auto-class only; confirmed
    // tools are recorded by the SDK's normal tool-result event.)
    expect(readAuditLines(tmpRoot)).toEqual([]);
  });

  it("clearTurnConfirms auto-denies pending requests so the SDK unwinds", async () => {
    const gate = makeGatedCanUseTool({
      cwd: tmpRoot,
      turnId: TURN_ID,
      onConfirmRequest: () => {},
    });
    const promise = gate("Edit", { file_path: `${tmpRoot}/x.ts`, old_string: "a", new_string: "b" }, SDK_CTX);

    clearTurnConfirms(TURN_ID);
    const result = await promise;
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toMatch(/aborted/);
    }
  });
});
