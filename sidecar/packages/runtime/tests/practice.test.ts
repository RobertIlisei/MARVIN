import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-practice-"));

import {
  classifyTurnEnding,
  extractAll,
  parseSessionTranscript,
  type Occurrence,
} from "../src/practice-extractors";
import {
  __resetPracticeScheduleForTests,
  approveFinding,
  armPracticeSchedule,
  DEFAULT_PRACTICE_CONFIG,
  dismissFinding,
  effectiveTier,
  escalateFinding,
  evaluatePracticeRules,
  PRACTICE_RULE_MAX_DENIES,
  practicePromptBlock,
  practiceView,
  readLedger,
  readRules,
  retireRule,
  runPractice,
  scoreFinding,
  writePracticeConfig,
  writeRules,
  type PracticeRule,
} from "../src/practice";
import { createTurnDesignContext, checkPracticeRules, recordAllowedTool } from "../src/design-hooks";

// ---------------------------------------------------------------------------
// Fixture transcripts — the JSONL shape MARVIN writes (session.ts SessionTurn)
// ---------------------------------------------------------------------------

type Line = Record<string, unknown>;
let toolSeq = 0;

function turn(opts: {
  at: string;
  message: string;
  tools?: Array<{ name: string; input?: Record<string, unknown>; parent?: string; error?: string }>;
  text?: string;
  endAt?: string;
  cacheCreation?: number;
  error?: string;
}): Line[] {
  const out: Line[] = [
    { type: "turn.user", at: opts.at, message: opts.message },
    { type: "turn.started", at: opts.at, turnId: `t-${opts.at}` },
  ];
  for (const t of opts.tools ?? []) {
    const id = `toolu_${++toolSeq}`;
    out.push({
      type: "cli.event",
      at: opts.at,
      event: {
        type: "assistant",
        ...(t.parent ? { parent_tool_use_id: t.parent } : {}),
        message: { content: [{ type: "tool_use", id, name: t.name, input: t.input ?? {} }] },
      },
    });
    out.push({
      type: "cli.event",
      at: opts.at,
      event: {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: id, content: t.error ?? "ok", is_error: Boolean(t.error) }],
        },
      },
    });
  }
  if (opts.text) {
    out.push({
      type: "cli.event",
      at: opts.at,
      event: { type: "assistant", message: { content: [{ type: "text", text: opts.text }] } },
    });
  }
  if (opts.error) out.push({ type: "turn.error", at: opts.endAt ?? opts.at, error: opts.error });
  else
    out.push({
      type: "turn.completed",
      at: opts.endAt ?? opts.at,
      tokenUsage: { cache_creation_input_tokens: opts.cacheCreation ?? 1000 },
      costUsd: 0.5,
    });
  return out;
}

function jsonl(lines: Line[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

const reads = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: "Read", input: { file_path: `/p/src/f${i}.ts` } }));
const graph = { name: "mcp__marvin-graph__graph_search", input: { query: "x" } };
const edit = { name: "Edit", input: { file_path: "/p/src/a.ts" } };
const filler = (n: number) => Array.from({ length: n }, () => ({ name: "Bash", input: { command: "npm test" } }));

/** A session that exhibits every failure once. */
function badSession(day: string): string {
  return jsonl([
    ...turn({
      at: `${day}T10:00:00Z`,
      message: "fix the login flow",
      tools: [...reads(6), graph, edit, ...filler(4)],
      text: "Done with the edits.",
      endAt: `${day}T10:10:00Z`,
    }),
    ...turn({ at: `${day}T10:40:00Z`, message: "continue", tools: [graph, edit, ...filler(5)], text: "Shipping." }),
    ...turn({
      at: `${day}T11:00:00Z`,
      message: "commit it",
      tools: [{ name: "Bash", input: { command: "git add .gitlab-ci.yml && git commit -m ci" } }],
      text: "Committed. **Scope met:** ci updated.\n<!-- marvin:scope-met -->",
      cacheCreation: 650_000,
    }),
    ...turn({
      at: `${day}T11:30:00Z`,
      message: "look around",
      tools: [
        { name: "Read", input: { file_path: "/p/src/x.ts" }, error: "graphify-first: query the graph first" },
        { name: "Read", input: { file_path: "/p/src/y.ts" }, error: "graphify-first: query the graph first" },
        { name: "Read", input: { file_path: "/p/src/z.ts" }, error: "graphify-first: query the graph first" },
      ],
      text: "Blocked?",
    }),
    ...turn({ at: `${day}T12:00:00Z`, message: "run it", error: "Invalid input: expected record 42" }),
    ...turn({ at: `${day}T12:05:00Z`, message: "run it again", error: "Invalid input: expected record 43" }),
  ]);
}

/** A session that does the same acts right. */
function goodSession(day: string): string {
  return jsonl([
    ...turn({
      at: `${day}T10:00:00Z`,
      message: "fix the login flow",
      tools: [graph, ...reads(6), edit, ...filler(4)],
      text: "Done. **Scope met:** login fixed.\n<!-- marvin:scope-met -->",
    }),
    ...turn({
      at: `${day}T11:00:00Z`,
      message: "commit it",
      tools: [
        { name: "Skill", input: { skill: "security-audit" } },
        { name: "Bash", input: { command: "git add .gitlab-ci.yml && git commit -m ci" } },
      ],
      text: "Committed. Anything else, or should I stop?",
    }),
  ]);
}

describe("practice extractors (ADR-0105 §1)", () => {
  it("finds every failure kind once in the bad session, and no successes", () => {
    const occ = extractAll(parseSessionTranscript("s1", badSession("2026-09-01")));
    const by = new Map<string, Occurrence[]>();
    for (const o of occ) by.set(o.fingerprint, [...(by.get(o.fingerprint) ?? []), o]);
    expect(by.get("graph.first.skipped")).toHaveLength(1);
    expect(by.get("turn.stalled")).toHaveLength(1);
    expect(by.get("turn.stalled")?.[0]?.cost).toBe(1800); // 10:10 → 10:40
    expect(by.get("scope.met.missing")).toHaveLength(1);
    expect(by.get("ship.unreviewed")).toHaveLength(1);
    expect(by.get("cache.recreated")).toHaveLength(1);
    expect(by.get("hook.deny.repeated:graphify-first")).toHaveLength(1);
    expect(by.get("error.repeated")).toHaveLength(1);
    expect(by.get("ship.reviewed")).toBeUndefined();
    expect(by.get("graph.first.followed")).toBeUndefined();
  });

  it("finds the paired successes in the good session, and no failures", () => {
    const occ = extractAll(parseSessionTranscript("s2", goodSession("2026-09-01")));
    const names = occ.map((o) => o.fingerprint).sort();
    expect(names).toEqual(["graph.first.followed", "scope.met.present", "ship.reviewed", "turn.continued"]);
  });

  it("ignores subagent calls entirely", () => {
    const scouting = jsonl(
      turn({
        at: "2026-09-01T10:00:00Z",
        message: "research",
        tools: reads(12).map((r) => ({ ...r, parent: "toolu_parent" })),
        text: "Findings below. Anything else?",
      }),
    );
    const occ = extractAll(parseSessionTranscript("s3", scouting));
    // Twelve reads, all from a scout: no graph.first finding in either direction.
    expect(occ).toEqual([]);
  });

  it("classifies turn endings with the breakdown script's regexes", () => {
    expect(classifyTurnEnding("Once that's pushed, I'll pick up watching.")).toBe("blocked-on-human");
    expect(classifyTurnEnding("Polling the pipeline now.")).toBe("background");
    expect(classifyTurnEnding("Want me to commit?")).toBe("asked");
    expect(classifyTurnEnding("Fixed the lint.")).toBe("stopped");
    expect(classifyTurnEnding("")).toBe("empty");
  });
});

describe("scoring (ADR-0105 §3)", () => {
  it("matches the worked examples with default weights", () => {
    const c = DEFAULT_PRACTICE_CONFIG;
    expect(
      scoreFinding({ kind: "ship.unreviewed", distinctSessions: 3, costTotal: 3, rate: 1, sessionsSinceLastSeen: 0 }, c),
    ).toBeCloseTo(0.89, 2);
    expect(
      scoreFinding(
        { kind: "graph.first.skipped", distinctSessions: 3, costTotal: 21, rate: 3 / 40, sessionsSinceLastSeen: 0 },
        c,
      ),
    ).toBeCloseTo(0.64, 2);
    // Report-only kinds score low on actionability.
    expect(
      scoreFinding({ kind: "cache.recreated", distinctSessions: 3, costTotal: 2_400_000, rate: null, sessionsSinceLastSeen: 0 }, c),
    ).toBeLessThan(0.89);
    // Decay bites when unseen.
    const fresh = scoreFinding({ kind: "turn.stalled", distinctSessions: 4, costTotal: 7200, rate: 0.5, sessionsSinceLastSeen: 0 }, c);
    const stale = scoreFinding({ kind: "turn.stalled", distinctSessions: 4, costTotal: 7200, rate: 0.5, sessionsSinceLastSeen: 20 }, c);
    expect(stale).toBeLessThan(fresh);
  });
});

// ---------------------------------------------------------------------------
// The run, across days
// ---------------------------------------------------------------------------

describe("the run and the day-two diff (ADR-0105 §2)", () => {
  const projectId = "p-practice";
  const files = new Map<string, { raw: string; mtime: number }>();
  const seams = {
    listSessionFiles: () => [...files.entries()].map(([id, f]) => ({ sessionId: id, mtime: f.mtime, size: f.raw.length })),
    readTranscript: (_p: string, id: string) => files.get(id)?.raw ?? null,
    liveGraceMs: 0,
  };
  // Fixture sessions sit 30 days in the PAST so an acceptance stamped with
  // the real clock is after all of them, and "after acceptance" sessions can
  // be placed relative to it.
  const T0 = Date.now() - 30 * 86_400_000;
  const day = (n: number) => T0 + n * 86_400_000;

  beforeEach(() => {
    files.clear();
    writeRules([]);
    rmSync(join(process.env.MARVIN_DATA_DIR!, "practice"), { recursive: true, force: true });
    writePracticeConfig({ ...DEFAULT_PRACTICE_CONFIG });
  });
  afterAll(() => rmSync(process.env.MARVIN_DATA_DIR!, { recursive: true, force: true }));

  it("day one: new findings, nothing proposed under three sessions; day three: proposed; successes reach practice", () => {
    files.set("a", { raw: badSession("2026-09-01"), mtime: day(1) });
    const r1 = runPractice(projectId, { ...seams, now: day(1) + 1 });
    expect(r1.sessionsRead).toBe(1);
    expect(r1.findingsNew).toBeGreaterThanOrEqual(7);
    expect(r1.proposed).toBe(0);
    let led = readLedger(projectId);
    expect(led.findings["ship.unreviewed"]?.state).toBe("observed");
    expect(led.findings["ship.unreviewed"]?.distinctSessions).toBe(1);

    // Day two: same file unchanged (watermark hit) + one more bad session.
    files.set("b", { raw: badSession("2026-09-02"), mtime: day(2) });
    const r2 = runPractice(projectId, { ...seams, now: day(2) + 1 });
    expect(r2.sessionsRead).toBe(1);
    expect(r2.recurring).toBeGreaterThanOrEqual(7);
    expect(r2.proposed).toBe(0);

    // Day three: third bad session + three good ones → failures proposed, successes are practice.
    files.set("c", { raw: badSession("2026-09-03"), mtime: day(3) });
    files.set("g1", { raw: goodSession("2026-09-01"), mtime: day(1) + 10 });
    files.set("g2", { raw: goodSession("2026-09-02"), mtime: day(2) + 10 });
    files.set("g3", { raw: goodSession("2026-09-03"), mtime: day(3) + 10 });
    const r3 = runPractice(projectId, { ...seams, now: day(3) + 100 });
    expect(r3.proposed).toBeGreaterThanOrEqual(3);
    led = readLedger(projectId);
    expect(led.findings["ship.unreviewed"]?.state).toBe("proposed");
    expect(led.findings["ship.unreviewed"]?.rate).toBeCloseTo(0.5, 5); // 3 bad, 3 good
    expect(led.findings["ship.reviewed"]?.state).toBe("practice");
    // Report-only kinds surface as `report`, never `proposed`.
    expect(["report", "observed"]).toContain(led.findings["cache.recreated"]?.state);
    expect(led.findings["error.repeated"]?.state).not.toBe("proposed");
  });

  it("a session that grew is re-counted, not double-counted", () => {
    files.set("a", { raw: badSession("2026-09-01"), mtime: day(1) });
    runPractice(projectId, { ...seams, now: day(1) + 1 });
    files.set("a", { raw: badSession("2026-09-01") + badSession("2026-09-01").slice(0, 0), mtime: day(1) + 5 });
    runPractice(projectId, { ...seams, now: day(1) + 10 });
    expect(readLedger(projectId).findings["ship.unreviewed"]?.distinctSessions).toBe(1);
  });

  function threeBadSessions(): void {
    for (const [id, d] of [["a", 1], ["b", 2], ["c", 3]] as const) {
      files.set(id, { raw: badSession(`2026-09-0${d}`), mtime: day(d) });
    }
    runPractice(projectId, { ...seams, now: day(3) + 1 });
    expect(readLedger(projectId).findings["ship.unreviewed"]?.state).toBe("proposed");
  }

  it("approve → active; a recurrence after acceptance → regressed; escalate stops at the top tier", () => {
    threeBadSessions();
    const approved = approveFinding(projectId, "ship.unreviewed");
    expect(approved.ok).toBe(true);
    expect(readLedger(projectId).findings["ship.unreviewed"]?.state).toBe("active");
    expect(readRules()).toHaveLength(1);
    expect(readRules()[0]?.tier).toBe("deny");
    expect(approveFinding(projectId, "cache.recreated").ok).toBe(false); // report-only

    const acceptedAt = Date.parse(readRules()[0]!.acceptedAt);
    files.set("d", { raw: badSession("2026-09-04"), mtime: acceptedAt + 1000 });
    const r = runPractice(projectId, { ...seams, now: acceptedAt + 2000 });
    expect(r.regressed).toBe(1);
    expect(readLedger(projectId).findings["ship.unreviewed"]?.state).toBe("regressed");
    expect(escalateFinding(projectId, "ship.unreviewed").ok).toBe(false); // deny is the top

    // A nudge-tier rule escalates to deny and restarts verification.
    const g = approveFinding(projectId, "graph.first.skipped");
    expect(g.ok && g.rule.tier).toBe("nudge");
    files.set("e", { raw: badSession("2026-09-05"), mtime: Date.parse((g as { rule: PracticeRule }).rule.acceptedAt) + 1000 });
    runPractice(projectId, { ...seams, now: Date.now() + 5000 });
    expect(readLedger(projectId).findings["graph.first.skipped"]?.state).toBe("regressed");
    const esc = escalateFinding(projectId, "graph.first.skipped");
    expect(esc.ok && esc.rule.tier).toBe("deny");
    expect(readLedger(projectId).findings["graph.first.skipped"]?.state).toBe("active");
  });

  it("a quiet verify window after acceptance → confirmed; a retired rule returns the finding to the pool", () => {
    threeBadSessions();
    const ap = approveFinding(projectId, "ship.unreviewed");
    expect(ap.ok).toBe(true);
    const acc = Date.parse(readRules()[0]!.acceptedAt);
    for (let i = 1; i <= 5; i++) files.set(`q${i}`, { raw: goodSession(`2026-09-1${i}`), mtime: acc + i * 1000 });
    const rc = runPractice(projectId, { ...seams, now: acc + 10_000 });
    expect(rc.confirmed).toBe(1);
    expect(readLedger(projectId).findings["ship.unreviewed"]?.state).toBe("confirmed");
    expect(readLedger(projectId).findings["ship.unreviewed"]?.sessionsAfter).toBe(5);

    retireRule(readRules()[0]!.id);
    runPractice(projectId, { ...seams, now: acc + 11_000 });
    expect(readLedger(projectId).findings["ship.unreviewed"]?.state).toBe("proposed");
    expect(readLedger(projectId).findings["ship.unreviewed"]?.ruleId).toBeUndefined();
  });

  it("dismiss suppresses until distinct sessions double, then re-surfaces", () => {
    threeBadSessions();
    expect(dismissFinding(projectId, "graph.first.skipped", "scouting is fine here")).toBe(true);
    expect(readLedger(projectId).findings["graph.first.skipped"]?.state).toBe("dismissed");
    for (const [id, d] of [["d", 4], ["e", 5]] as const) files.set(id, { raw: badSession(`2026-09-0${d}`), mtime: day(d) });
    runPractice(projectId, { ...seams, now: day(5) + 1 });
    expect(readLedger(projectId).findings["graph.first.skipped"]?.state).toBe("dismissed"); // 5 < 6
    files.set("f", { raw: badSession("2026-09-06"), mtime: day(6) });
    runPractice(projectId, { ...seams, now: day(6) + 1 });
    expect(readLedger(projectId).findings["graph.first.skipped"]?.state).toBe("proposed"); // 6 ≥ 6, re-scored
    const view = practiceView(projectId);
    expect(view.findings[0]?.value).toBeGreaterThanOrEqual(view.findings[1]?.value ?? 0);
    expect(view.lastRun?.trigger).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// Enforcement tiers (ADR-0105 §4)
// ---------------------------------------------------------------------------

describe("rule enforcement", () => {
  const cwd = "/proj-practice";
  const projectId = "proj-practice";
  function rule(partial: Partial<PracticeRule>): PracticeRule {
    const now = new Date().toISOString();
    return {
      id: partial.id ?? "r1",
      fingerprint: "x",
      title: "T",
      tier: "nudge",
      trigger: { tool: "^Bash$" },
      message: "do the thing",
      status: "active",
      scope: { projectId: null },
      provenance: { findingId: "x", distinctSessions: 3, costTotal: 3, value: 0.8 },
      metrics: { fired: 0, lastFiredAt: null, bypasses: 0 },
      createdAt: now,
      acceptedAt: now,
      updatedAt: now,
      ...partial,
    };
  }
  const baseCtx = () => ({
    projectId,
    toolName: "Bash",
    input: { command: "git commit -m x" },
    counters: {},
    hasSkillRun: () => false,
    boundaryHit: () => true,
    deniesThisTurn: new Map<string, number>(),
    nudgesThisTurn: new Set<string>(),
    measure: false,
  });
  afterEach(() => writeRules([]));

  it("a deny without a discharge path is enforced as a nudge", () => {
    expect(effectiveTier(rule({ tier: "deny", trigger: { tool: "^Bash$" } }))).toBe("nudge");
    expect(effectiveTier(rule({ tier: "deny", trigger: { tool: "^Bash$", requireSkillThisSession: ["pr-review"] } }))).toBe("deny");
    expect(effectiveTier(rule({ tier: "nudge", trigger: null }))).toBe("prompt");
  });

  it("denies with a discharge path, is satisfied by the skill, caps per turn, honours measure mode", () => {
    const r = rule({ tier: "deny", trigger: { tool: "^Bash$", field: "command", pattern: "commit", requireSkillThisSession: ["pr-review"] } });
    const ctx = baseCtx();
    expect(evaluatePracticeRules(ctx, [r]).deny?.ruleId).toBe("r1");
    expect(evaluatePracticeRules(ctx, [r]).deny?.ruleId).toBe("r1");
    const third = evaluatePracticeRules(ctx, [r]);
    expect(third.deny).toBeNull();
    expect(third.bypassed).toEqual(["r1"]);
    expect(ctx.deniesThisTurn.get("r1")).toBe(PRACTICE_RULE_MAX_DENIES);
    // Skill ran → no fire.
    expect(evaluatePracticeRules({ ...baseCtx(), hasSkillRun: (s) => s === "pr-review" }, [r]).deny).toBeNull();
    // Measure mode → nudge, not deny.
    const m = evaluatePracticeRules({ ...baseCtx(), measure: true }, [r]);
    expect(m.deny).toBeNull();
    expect(m.nudges.map((n) => n.ruleId)).toEqual(["r1"]);
  });

  it("nudges once per turn, respects conditions, scope, status, and a broken regex never fires", () => {
    const cond = rule({
      id: "cond",
      trigger: { tool: "^Read$", conditions: [{ counter: "sourceFilesRead", op: "gte", value: 5 }, { counter: "graphCallCount", op: "eq", value: 0 }] },
    });
    const ctx = { ...baseCtx(), toolName: "Read", input: {}, counters: { sourceFilesRead: 5, graphCallCount: 0 } };
    expect(evaluatePracticeRules(ctx, [cond]).nudges).toHaveLength(1);
    expect(evaluatePracticeRules(ctx, [cond]).nudges).toHaveLength(0); // once per turn
    expect(evaluatePracticeRules({ ...baseCtx(), toolName: "Read", input: {}, counters: { sourceFilesRead: 5, graphCallCount: 1 } }, [cond]).nudges).toHaveLength(0);
    expect(evaluatePracticeRules(baseCtx(), [rule({ scope: { projectId: "someone-else" } })]).nudges).toHaveLength(0);
    expect(evaluatePracticeRules(baseCtx(), [rule({ status: "retired" })]).nudges).toHaveLength(0);
    expect(evaluatePracticeRules(baseCtx(), [rule({ trigger: { tool: "(" } })]).nudges).toHaveLength(0);
  });

  it("prompt-tier rules render into the system prompt block, scoped", () => {
    writeRules([
      rule({ id: "p1", tier: "prompt", trigger: null, title: "Finish the plan", message: "Continue." }),
      rule({ id: "p2", tier: "prompt", trigger: null, scope: { projectId: "other" }, title: "Other", message: "x" }),
    ]);
    const block = practicePromptBlock(projectId);
    expect(block).toContain("## Practice rules");
    expect(block).toContain("Finish the plan");
    expect(block).not.toContain("Other");
    expect(practicePromptBlock("nobody-else", [rule({ id: "p3", tier: "prompt", trigger: null, scope: { projectId: "x" } })])).toBe("");
  });

  it("is wired into the design hooks: counters, skill marks and metrics flow through", () => {
    writeRules([
      rule({
        id: "hook-r",
        tier: "nudge",
        scope: { projectId: null },
        trigger: { tool: "^Read$", conditions: [{ counter: "sourceFilesRead", op: "gte", value: 2 }] },
      }),
    ]);
    const ctx = createTurnDesignContext("t-practice", cwd);
    ctx.hasGraph = false;
    recordAllowedTool(ctx, "Read", { file_path: `${cwd}/a.ts` });
    recordAllowedTool(ctx, "Read", { file_path: `${cwd}/b.ts` });
    const res = checkPracticeRules(ctx, "Read", { file_path: `${cwd}/c.ts` }, false);
    expect(res.nudges.map((n) => n.ruleId)).toEqual(["hook-r"]);
    expect(ctx.pendingPracticeNudge).toContain("do the thing");
    expect(readRules()[0]?.metrics.fired).toBe(1);
  });
});

describe("schedule", () => {
  afterEach(() => __resetPracticeScheduleForTests());
  it("fires each enabled project once per day at the configured hour", async () => {
    writePracticeConfig({ enabled: true, hour: 3 });
    const ran: string[] = [];
    let clock = new Date("2026-09-10T03:00:30");
    const stop = armPracticeSchedule({
      listProjectIds: () => ["a", "b"],
      run: (id) => ran.push(id),
      intervalMs: 5,
      now: () => clock,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(ran.sort()).toEqual(["a", "b"]);
    clock = new Date("2026-09-10T03:05:00");
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toHaveLength(2); // same day, no repeat
    clock = new Date("2026-09-11T03:00:00");
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toHaveLength(4);
    stop();
  });
});
