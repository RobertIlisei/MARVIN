import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAutoModeLogger } from "../src/sdk-runner";
import {
  buildSupervisorQueryOptions,
  makeSupervisorCanUseTool,
  ROTATE_AT_INPUT_TOKENS,
  runSupervisorWake,
  SUPERVISOR_DISALLOWED_TOOLS,
} from "../src/supervisor-dispatch";
import { readLedger } from "../src/supervisor-ledger";
import { ActionLimiter } from "../src/supervisor-policy";
import { SUPERVISOR_SYSTEM_PROMPT } from "../src/supervisor-prompt";
import {
  applySupervisorAction,
  bootSupervisor,
  currentSupervisorToken,
  getSupervisorState,
  resetSupervisorStateForTests,
  supervisorTokenPath,
  updateSupervisorRuntime,
} from "../src/supervisor-state";

// ADR-0127 §2 — the supervisor session is runtime-dispatched, belt-and-braces
// read-only (SDK disallowedTools + a closed canUseTool), and holds exactly
// two MCP servers. The executor never holds `marvin-supervise`.

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-disp-data-"));
  workDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-disp-work-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  applySupervisorAction({ projectId: "proj", action: "start" }, currentSupervisorToken() as string);
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const verbCtx = () => ({
  projectId: "proj",
  workDir,
  wakeId: "w",
  wake: { acts: 0 },
  limiter: new ActionLimiter(() => getSupervisorState("proj").caps),
  deps: {
    listRows: async () => [],
    getPending: () => null,
    readTranscriptTail: () => "",
    readBrief: () => null,
    tabStartedAt: () => null,
    readPlanText: () => "",
    modelLookup: async () => () => null,
  },
});

const opts = (mcpServer?: { name: string; source: string }) =>
  ({ signal: new AbortController().signal, toolUseID: "t", ...(mcpServer ? { mcpServer } : {}) }) as never;

describe("containment — the supervisor's tool set", () => {
  it("refuses every mutator, the web, TodoWrite and every subagent-dispatch spelling at the SDK layer", () => {
    for (const t of ["Edit", "Write", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "TodoWrite", "Task", "Agent"]) {
      expect(SUPERVISOR_DISALLOWED_TOOLS, t).toContain(t);
    }
    expect(SUPERVISOR_DISALLOWED_TOOLS).not.toContain("Read");
  });

  it("the query holds exactly marvin-supervise and marvin-graph, runs in the project root, capped, with no settings and no token", () => {
    const { options } = buildSupervisorQueryOptions({ projectId: "proj", workDir, prompt: "p", resume: null, model: undefined, verbCtx: verbCtx() });
    expect(Object.keys(options.mcpServers ?? {}).sort()).toEqual(["marvin-graph", "marvin-supervise"]);
    expect(options.disallowedTools).toEqual([...SUPERVISOR_DISALLOWED_TOOLS]);
    expect(options.cwd).toBe(workDir);
    expect(options.maxTurns).toBe(getSupervisorState("proj").caps.maxTurnsPerWake);
    expect(options.settingSources).toEqual([]);
    expect(options.systemPrompt).toBe(SUPERVISOR_SYSTEM_PROMPT);
    expect(typeof options.canUseTool).toBe("function");
    const token = readFileSync(supervisorTokenPath(), "utf8").trim();
    expect(Object.values(options.env ?? {})).not.toContain(token);
    expect(Object.keys(options.env ?? {}).filter((k) => /SUPERVISOR/i.test(k))).toEqual([]);
  });

  it.each([
    ["Read", { file_path: ".env" }, "deny"],
    ["Read", { file_path: "config/.env.local" }, "deny"],
    ["Read", { file_path: "certs/server.pem" }, "deny"],
    ["Read", { file_path: "src/billing.ts" }, "allow"],
    ["Read", { file_path: "/home/me/.ssh/config" }, "deny"],
    ["Read", { file_path: "../../etc/passwd" }, "deny"],
    ["Grep", { pattern: "KEY", path: ".env" }, "deny"],
    ["Grep", { pattern: "KEY", glob: ".env*" }, "deny"],
    ["Grep", { pattern: "KEY", path: "/Users" }, "deny"],
    ["Grep", { pattern: "invoice", path: "src" }, "allow"],
    ["Grep", { pattern: "invoice" }, "allow"],
    ["Glob", { pattern: "**/.env*" }, "deny"],
    ["Glob", { pattern: "/Users/**/*.ts" }, "deny"],
    ["Glob", { pattern: "src/**/*.ts" }, "allow"],
    ["Edit", { file_path: "a.ts" }, "deny"],
    ["Bash", { command: "ls" }, "deny"],
    ["Agent", { subagent_type: "scout" }, "deny"],
    ["AskUserQuestion", { questions: [] }, "deny"],
    ["ToolSearch", { query: "x" }, "deny"],
  ] as const)("canUseTool %s %j → %s", async (tool, input, expected) => {
    const r = await makeSupervisorCanUseTool({ workDir })(tool, input as Record<string, unknown>, opts());
    expect(r?.behavior).toBe(expected);
  });

  it("follows a symlink before deciding: a harmless name pointing at .env is still a secret", async () => {
    writeFileSync(path.join(workDir, ".env"), "KEY=1\n");
    mkdirSync(path.join(workDir, "config"), { recursive: true });
    symlinkSync(path.join(workDir, ".env"), path.join(workDir, "config", "current"));
    const r = await makeSupervisorCanUseTool({ workDir })("Read", { file_path: "config/current" }, opts());
    expect(r?.behavior).toBe("deny");
  });

  it("the PreToolUse hook gives Read/Grep/Glob the same decision — the SDK auto-allows them without canUseTool", async () => {
    const { options } = buildSupervisorQueryOptions({ projectId: "proj", workDir, prompt: "p", resume: null, model: undefined, verbCtx: verbCtx() });
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(hook).toBeTypeOf("function");
    const call = (tool_name: string, tool_input: Record<string, unknown>) =>
      hook?.({ hook_event_name: "PreToolUse", tool_name, tool_input } as never, "id", { signal: new AbortController().signal });
    const denied = (await call("Read", { file_path: ".env" })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(await call("Read", { file_path: "src/a.ts" })).toEqual({});
    const glob = (await call("Glob", { pattern: "**/.env*" })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(glob.hookSpecificOutput?.permissionDecision).toBe("deny");
    const outside = (await call("Grep", { pattern: "x", path: "/Users" })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(outside.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("refuses a read of its own token", async () => {
    const r = await makeSupervisorCanUseTool({ workDir })("Read", { file_path: supervisorTokenPath() }, opts());
    expect(r?.behavior).toBe("deny");
  });

  it("admits marvin-supervise only from the in-process server; graph only its read verbs, and not from a non-sdk twin", async () => {
    const can = makeSupervisorCanUseTool({ workDir });
    expect((await can("mcp__marvin-supervise__answer", {}, opts({ name: "marvin-supervise", source: "sdk" })))?.behavior).toBe("allow");
    expect((await can("mcp__marvin-supervise__answer", {}, opts({ name: "marvin-supervise", source: "stdio" })))?.behavior).toBe("deny");
    expect((await can("mcp__marvin-supervise__answer", {}, opts()))?.behavior).toBe("deny");
    expect((await can("mcp__marvin-graph__graph_query", {}, opts({ name: "marvin-graph", source: "sdk" })))?.behavior).toBe("allow");
    expect((await can("mcp__marvin-graph__graph_query", {}, opts({ name: "marvin-graph", source: "stdio" })))?.behavior).toBe("deny");
    for (const w of ["graph_save_result", "graph_reflect", "graph_export_callflow", "graph_index_schema"]) {
      expect((await can(`mcp__marvin-graph__${w}`, {}, opts({ name: "marvin-graph", source: "sdk" })))?.behavior, w).toBe("deny");
    }
    expect((await can("mcp__marvin-backlog__backlog_add", {}, opts({ name: "marvin-backlog", source: "sdk" })))?.behavior).toBe("deny");
  });

  it("ledgers each provenance refusal, and pauses itself after three in one wake", async () => {
    const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
    const q = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
      calls.push(args);
      const can = args.options.canUseTool as (n: string, i: Record<string, unknown>, o: unknown) => Promise<unknown>;
      return (async function* () {
        for (let i = 0; i < 3; i += 1) await can("mcp__marvin-supervise__answer", {}, opts({ name: "marvin-supervise", source: "stdio" }));
        yield { type: "result", subtype: "success", session_id: "s", total_cost_usd: 0, usage: {} };
      })();
    }) as never;
    await runSupervisorWake({ projectId: "proj", workDir, items: [], verbCtx: verbCtx() }, { query: q, resolveModel: async () => undefined });
    const lines = readLedger("proj");
    expect(lines.filter((e) => e.reason.startsWith("provenance:"))).toHaveLength(3);
    expect(lines.some((e) => e.verb === "auto-pause" && e.decision === "escalate")).toBe(true);
    expect(getSupervisorState("proj").paused).toBe(true);
  });

  it("marvin-supervise is absent from every executor turn: runAgent never registers it, and the executor gate denies it", async () => {
    const src = readFileSync(path.join(__dirname, "../src/sdk-runner.ts"), "utf8");
    expect(src).not.toMatch(/supervisor-mcp|createSupervisorMcpServer|marvin-supervise/);
    const gate = makeAutoModeLogger({ cwd: workDir, workDir, turnId: "t-exec", permissionStrategy: "full" });
    const r = await gate("mcp__marvin-supervise__answer", {}, opts({ name: "marvin-supervise", source: "sdk" }));
    expect(r?.behavior).toBe("deny");
  });
});

/** A stub `query` that records its args and replays a fixed event stream. */
function stubQuery(events: unknown[], calls: Array<{ prompt: unknown; options: Record<string, unknown> }>) {
  return ((args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    return (async function* () {
      for (const e of events) yield e;
    })();
  }) as never;
}

describe("runSupervisorWake — one bounded turn, its cost, its session", () => {
  const events = (sessionId: string, cost: number, input: number) => [
    { type: "system", subtype: "init", session_id: sessionId },
    { type: "result", subtype: "success", session_id: sessionId, total_cost_usd: cost, usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  ];

  it("starts a fresh session, records its id, spend and context size, and ledgers the wake", async () => {
    const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
    const r = await runSupervisorWake(
      { projectId: "proj", workDir, items: [], verbCtx: verbCtx() },
      { query: stubQuery(events("sdk-1", 0.25, 1_000), calls), resolveModel: async () => undefined },
    );
    expect(r.ok).toBe(true);
    expect(calls[0]?.options.resume).toBeUndefined();
    const s = getSupervisorState("proj");
    expect(s.sdkSessionId).toBe("sdk-1");
    expect(s.spend.usd).toBeCloseTo(0.25);
    expect(s.lastInputTokens).toBe(1_000);
    expect(readLedger("proj").filter((e) => e.kind === "wake").map((e) => e.verb)).toEqual(["start", "end"]);
  });

  it("resumes the session across wakes, and rotates once the context passes half the window", async () => {
    updateSupervisorRuntime("proj", { sdkSessionId: "sdk-old", sdkSessionStartedAt: new Date().toISOString(), lastInputTokens: 10 });
    const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
    await runSupervisorWake({ projectId: "proj", workDir, items: [], verbCtx: verbCtx() }, { query: stubQuery(events("sdk-old", 0, 10), calls), resolveModel: async () => undefined });
    expect(calls[0]?.options.resume).toBe("sdk-old");

    updateSupervisorRuntime("proj", { lastInputTokens: ROTATE_AT_INPUT_TOKENS + 1 });
    await runSupervisorWake({ projectId: "proj", workDir, items: [], verbCtx: verbCtx() }, { query: stubQuery(events("sdk-new", 0, 10), calls), resolveModel: async () => undefined });
    expect(calls[1]?.options.resume).toBeUndefined();
    expect(getSupervisorState("proj").sdkSessionId).toBe("sdk-new");
    expect(readLedger("proj").filter((e) => e.kind === "rotation")).toHaveLength(1);
  });

  it("a failed wake is reported, ledgered and does not throw", async () => {
    const boom = (() => {
      throw new Error("network down");
    }) as never;
    const r = await runSupervisorWake({ projectId: "proj", workDir, items: [], verbCtx: verbCtx() }, { query: boom, resolveModel: async () => undefined });
    expect(r.ok).toBe(false);
    expect(readLedger("proj").at(-1)?.reason).toMatch(/network down/);
  });
});
