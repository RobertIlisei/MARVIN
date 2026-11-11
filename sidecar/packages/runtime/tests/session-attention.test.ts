import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before any import that reads the data dir: the practice rows live there.
process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-attention-data-"));

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetBackgroundJobsForTests, __setJobsFileForTests, startBackgroundJob } from "../src/background-jobs";
import { __resetBuiltinCacheForTests, ensureBuiltinRules, readRules, updateRule } from "../src/practice";
import { attentionPatchForTurn, decideAttention } from "../src/session-attention";
import { nextAttention } from "../src/session-meta";
import { __resetSchedulerForTests, MAX_CHAIN_DEPTH, scheduleWakeup } from "../src/wakeup-scheduler";
import { createWakeupMcpServer, type WakeupToolContext } from "../src/wakeup-tools";

// ADR-0130 §2, §3 — the two silent stops reach the user.

const base = { turnId: "t1", askedUserQuestion: false, scopeMet: false, waitingOnOwn: false, proseQuestionOff: false };
const ASK = "I changed the migration.\n\nShall I go ahead with step 1?";

describe("nextAttention", () => {
  it("any turn start clears it; a user-started turn also stamps lastUserTurnAt", () => {
    expect(nextAttention({ phase: "start", kind: "machine" })).toEqual({ attention: undefined });
    expect(nextAttention({ phase: "start", kind: "human", author: "supervisor" })).toEqual({ attention: undefined });
    expect(nextAttention({ phase: "start", kind: "human", at: "2026-11-11T10:00:00Z" })).toEqual({ attention: undefined, lastUserTurnAt: "2026-11-11T10:00:00Z" });
  });

  it("a turn end sets it when raised and otherwise leaves it alone", () => {
    expect(nextAttention({ phase: "end", raised: null })).toBeNull();
    expect(nextAttention({ phase: "end", raised: { kind: "prose-question", excerpt: "q?", turnId: "t1" }, at: "2026-11-11T10:00:00Z" })).toEqual({
      attention: { kind: "prose-question", excerpt: "q?", turnId: "t1", since: "2026-11-11T10:00:00Z" },
    });
  });
});

describe("decideAttention", () => {
  it("a closing question raises, with the final paragraph as the excerpt", () => {
    expect(decideAttention({ ...base, finalText: ASK })).toEqual({ kind: "prose-question", excerpt: "Shall I go ahead with step 1?", turnId: "t1" });
  });

  it("a blocked-on-human ending raises too", () => {
    expect(decideAttention({ ...base, finalText: "Pushed to the branch.\n\nI'll wait for your go-ahead before I touch main." })?.kind).toBe("prose-question");
  });

  it("caps a long excerpt", () => {
    const long = `Context.\n\nShould I ${"really ".repeat(100)}proceed?`;
    const out = decideAttention({ ...base, finalText: long });
    expect(out?.excerpt.length).toBeLessThanOrEqual(300);
  });

  it("a scope-met close does not raise", () => {
    expect(decideAttention({ ...base, finalText: ASK, scopeMet: true })).toBeNull();
  });

  it("a question in the middle of the text does not raise", () => {
    expect(decideAttention({ ...base, finalText: "Shall I go ahead? I decided to, and it is done.\n\nAll tests pass." })).toBeNull();
  });

  it("a turn that called AskUserQuestion does not raise", () => {
    expect(decideAttention({ ...base, finalText: ASK, askedUserQuestion: true })).toBeNull();
  });

  it("a session with its own job or wakeup pending does not raise", () => {
    expect(decideAttention({ ...base, finalText: ASK, waitingOnOwn: true })).toBeNull();
  });

  it("the row switched off raises no prose question", () => {
    expect(decideAttention({ ...base, finalText: ASK, proseQuestionOff: true })).toBeNull();
  });

  it("a chain-cap refusal raises, and outranks a prose question from the same turn", () => {
    const out = decideAttention({ ...base, finalText: ASK, chainCap: { what: "job", label: "pnpm test:full" } });
    expect(out?.kind).toBe("chain-cap");
    expect(out?.excerpt).toContain("pnpm test:full");
    // …and is not governed by the prose-question row.
    expect(decideAttention({ ...base, finalText: "done", proseQuestionOff: true, chainCap: { what: "wakeup", label: "check gate" } })?.kind).toBe("chain-cap");
  });
});

describe("attentionPatchForTurn and the builtin:prose-question row", () => {
  beforeEach(() => {
    ensureBuiltinRules();
    __resetBuiltinCacheForTests();
  });

  it("ships at nudge; raises and counts the fire; switched off, nothing is raised", () => {
    expect(readRules().find((r) => r.id === "builtin:prose-question")?.tier).toBe("nudge");
    const patch = attentionPatchForTurn({ marvinSessionId: "s", turnId: "t1", result: { finalText: ASK } });
    expect(patch?.attention?.kind).toBe("prose-question");
    expect(readRules().find((r) => r.id === "builtin:prose-question")?.metrics.fired).toBe(1);

    updateRule("builtin:prose-question", { status: "retired" });
    __resetBuiltinCacheForTests();
    expect(attentionPatchForTurn({ marvinSessionId: "s", turnId: "t2", result: { finalText: ASK } })).toBeNull();
  });

  it("at the deny tier it is still advisory: raised, never blocking (the item is the only effect)", () => {
    updateRule("builtin:prose-question", { tier: "deny", status: "active" });
    __resetBuiltinCacheForTests();
    expect(attentionPatchForTurn({ marvinSessionId: "s", turnId: "t3", result: { finalText: ASK } })?.attention?.kind).toBe("prose-question");
  });
});

describe("the chain-cap refusal", () => {
  let jobsFile: string;
  beforeEach(() => {
    jobsFile = join(mkdtempSync(join(tmpdir(), "marvin-attention-jobs-")), "jobs.json");
    __setJobsFileForTests(jobsFile);
  });
  afterEach(() => {
    __resetBackgroundJobsForTests();
    __resetSchedulerForTests();
    __setJobsFileForTests(null);
  });

  const ctx = { marvinSessionId: "s", projectId: "p", cwd: process.cwd(), model: "m", advisorModel: null, personality: "marvin" as const, permissionStrategy: "auto" as const, thinkingMode: "high", depth: MAX_CHAIN_DEPTH };

  it("returns a code beside the error for the depth refusal, in both entry points", () => {
    const job = startBackgroundJob({ command: "echo hi", reason: "x", ctx });
    expect(job).toMatchObject({ ok: false, code: "chain-depth" });
    const wake = scheduleWakeup({
      marvinSessionId: "s", projectId: "p", cwd: process.cwd(), model: "m", advisorModel: null, personality: "marvin", permissionStrategy: "auto", thinkingMode: "high",
      delaySeconds: 600, reason: "r", prompt: "p", schedulingDepth: MAX_CHAIN_DEPTH,
    });
    expect(wake).toMatchObject({ ok: false, code: "chain-depth" });
    // Other refusals carry none.
    expect(startBackgroundJob({ command: " ", reason: "x", ctx: { ...ctx, depth: 0 } })).toEqual({ ok: false, error: "command is empty" });
  });

  it("the tools note the refusal on the turn and tell the model the user has been notified", async () => {
    const noted: unknown[] = [];
    const toolCtx: WakeupToolContext = { ...ctx, onChainCap: (r) => noted.push(r) };
    const server = createWakeupMcpServer(toolCtx) as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> } };
    const run = await server.instance._registeredTools.run_background_job?.handler({ command: "pnpm test:full", reason: "gate" }, {});
    expect(run?.content[0]?.text).toMatch(/user has been notified/);
    expect(run?.content[0]?.text).toMatch(/END THE TURN/);
    expect(run?.content[0]?.text).not.toMatch(/send any message and/i);
    const wake = await server.instance._registeredTools.schedule_wakeup?.handler({ delaySeconds: 600, reason: "check gate", prompt: "go" }, {});
    expect(wake?.content[0]?.text).toMatch(/user has been notified/);
    expect(noted).toEqual([
      { what: "job", label: "pnpm test:full" },
      { what: "wakeup", label: "check gate" },
    ]);
  });
});
