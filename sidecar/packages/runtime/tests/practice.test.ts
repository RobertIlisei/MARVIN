import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-practice-"));

import { checkPracticeRules, createTurnDesignContext, recordAllowedTool } from "../src/design-hooks";
import {
  __resetPracticeScheduleForTests,
  approveFinding,
  armPracticeSchedule,
  DEFAULT_PRACTICE_CONFIG,
  dismissFinding,
  undismissFinding,
  resetPracticeLedger,
  effectiveTier,
  escalateFinding,
  evaluatePracticeRules,
  markFindingFixed,
  PRACTICE_RULE_MAX_DENIES,
  type PracticeRule,
  practicePromptBlock,
  practiceView,
  readLedger,
  readRules,
  retireRule,
  runPractice,
  scoreFinding,
  writePracticeConfig,
  writeRules,
} from "../src/practice";
import {
  classifyPlanShape,
  classifyTurnEnding,
  extractAll,
  type Occurrence,
  PREORIENT_SUBTYPE,
  parseSessionTranscript,
  planStepsOf,
} from "../src/practice-extractors";

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
  costUsd?: number;
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
      costUsd: opts.costUsd ?? 0.5,
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
    expect(names).toEqual(["graph.first.followed", "scope.met.present", "ship.reviewed", "skill.invoked:security-audit", "turn.continued"]);
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

describe("phase 2 extractors", () => {
  const skillRead = (name: string) => ({ name: "Read", input: { file_path: `/Users/x/.claude/skills/${name}/SKILL.md` } });
  const skill = (name: string) => ({ name: "Skill", input: { skill: name } });
  const todo = { name: "TodoWrite", input: { todos: [{ content: "[1] x", status: "in_progress" }] } };
  const failing = (cmd: string) => ({ name: "Bash", input: { command: cmd }, error: "exit 1" });
  const ids = (raw: string) => extractAll(parseSessionTranscript("p2", raw)).map((o) => o.fingerprint).sort();

  it("skill.bypassed when a skill's folder is read by hand; skill.invoked when the tool is used first", () => {
    expect(ids(jsonl(turn({ at: "2026-09-01T10:00:00Z", message: "review this", tools: [skillRead("pr-review"), skillRead("pr-review")], text: "ok?" })))).toEqual([
      "skill.bypassed:pr-review",
    ]);
    const invokedFirst = jsonl(turn({ at: "2026-09-01T10:00:00Z", message: "review this", tools: [skill("marvin:pr-review"), skillRead("pr-review")], text: "ok?" }));
    expect(ids(invokedFirst)).toEqual(["skill.invoked:pr-review"]);
    const occ = extractAll(parseSessionTranscript("p2", jsonl(turn({ at: "2026-09-01T10:00:00Z", message: "m", tools: [skillRead("tdd"), skillRead("tdd"), skillRead("tdd")] }))));
    expect(occ.find((o) => o.fingerprint === "skill.bypassed:tdd")?.cost).toBe(3);
    // A shell listing of the folder names the skill, not its arguments.
    const listed = jsonl(turn({ at: "2026-09-01T10:00:00Z", message: "m", tools: [{ name: "Bash", input: { command: "find .claude/skills/hetzner-ssh -type f 2>/dev/null" } }], text: "?" }));
    expect(ids(listed)).toEqual(["skill.bypassed:hetzner-ssh"]);
  });

  it("review.ignored only when findings were reported and nothing was edited after; nit-only reports do not count", () => {
    const ignored = jsonl(turn({ at: "2026-09-01T10:00:00Z", message: "ship", tools: [edit, skill("pr-review")], text: "[Important] SQL built by string concat in repo.ts" }));
    expect(ids(ignored)).toContain("review.ignored");
    const acted = jsonl(turn({ at: "2026-09-01T10:00:00Z", message: "ship", tools: [skill("security-audit"), edit], text: "Findings: 2 high. Fixed both." }));
    expect(ids(acted)).toContain("review.acted");
    expect(ids(acted)).not.toContain("review.ignored");
    const nits = jsonl(turn({ at: "2026-09-01T10:00:00Z", message: "ship", tools: [skill("pr-review")], text: "Clean. [Nit] rename a variable." }));
    expect(ids(nits)).not.toContain("review.ignored");
  });

  it("plan.stale when three edits happen with the plan untouched this turn and next; plan.kept otherwise; last turn skipped", () => {
    const stale = jsonl([
      ...turn({ at: "2026-09-01T10:00:00Z", message: "plan", tools: [todo], text: "Plan set. Proceed?" }),
      ...turn({ at: "2026-09-01T10:10:00Z", message: "go", tools: [edit, edit, edit], text: "Edited. Next?" }),
      ...turn({ at: "2026-09-01T10:20:00Z", message: "go on", tools: [edit], text: "More. Next?" }),
      ...turn({ at: "2026-09-01T10:30:00Z", message: "end", tools: [edit, edit, edit], text: "Done?" }),
    ]);
    const o = ids(stale);
    expect(o.filter((x) => x === "plan.stale")).toHaveLength(1); // turn 2; turn 4 is last and skipped
    const kept = jsonl([
      ...turn({ at: "2026-09-01T10:00:00Z", message: "plan", tools: [todo], text: "Plan set. Proceed?" }),
      ...turn({ at: "2026-09-01T10:10:00Z", message: "go", tools: [edit, edit, edit, todo], text: "Edited. Next?" }),
      ...turn({ at: "2026-09-01T10:20:00Z", message: "end", text: "Done?" }),
    ]);
    expect(ids(kept)).toContain("plan.kept");
    expect(ids(kept)).not.toContain("plan.stale");
    // No plan ever started → nothing to keep or lose.
    expect(ids(jsonl([...turn({ at: "2026-09-01T10:00:00Z", message: "a", tools: [edit, edit, edit], text: "x?" }), ...turn({ at: "2026-09-01T10:10:00Z", message: "b", text: "y?" })]))).not.toContain("plan.stale");
  });

  it("command.retried counts verbatim re-runs of a failing command; command.adapted when a failure was not repeated", () => {
    const retried = jsonl(turn({ at: "2026-09-01T10:00:00Z", message: "test", tools: [failing("npm test"), failing("npm  test"), failing("npm test")], text: "hmm?" }));
    const occ = extractAll(parseSessionTranscript("p2", retried));
    expect(occ.find((o) => o.fingerprint === "command.retried")?.cost).toBe(2);
    const adapted = jsonl(turn({ at: "2026-09-01T10:00:00Z", message: "test", tools: [failing("npm test"), { name: "Bash", input: { command: "npm test -- --runInBand" } }], text: "ok?" }));
    expect(ids(adapted)).toContain("command.adapted");
    expect(ids(adapted)).not.toContain("command.retried");
  });

  it("turn.overbudget is report-only and honours the threshold", () => {
    const pricey = jsonl(turn({ at: "2026-09-01T10:00:00Z", message: "big", text: "done?", costUsd: 12 }));
    expect(extractAll(parseSessionTranscript("p2", pricey)).map((o) => o.fingerprint)).toContain("turn.overbudget");
    expect(extractAll(parseSessionTranscript("p2", pricey), { turnOverbudgetUsd: 20 }).map((o) => o.fingerprint)).not.toContain("turn.overbudget");
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
    // Occurrence timestamps must sit clearly BEFORE an acceptance stamped
    // with the real clock, so verification does not read them as recurrences.
    for (const [id, d] of [["a", 1], ["b", 2], ["c", 3]] as const) {
      files.set(id, { raw: badSession(`2026-01-0${d}`), mtime: day(d) });
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
    files.set("d", { raw: badSession("2027-01-04"), mtime: acceptedAt + 1000 }); // occurrences dated AFTER acceptance
    const one = runPractice(projectId, { ...seams, now: acceptedAt + 2000 });
    // One recurring session is not a regression (2026-09-09): the rate before
    // was 3 of 3 sessions, one of one after is above half of it, but a single
    // session is not evidence. Two are.
    expect(one.regressed).toBe(0);
    expect(readLedger(projectId).findings["ship.unreviewed"]?.state).toBe("active");
    files.set("d2", { raw: badSession("2027-01-05"), mtime: acceptedAt + 1500 });
    const r = runPractice(projectId, { ...seams, now: acceptedAt + 3000 });
    expect(r.regressed).toBe(1);
    expect(readLedger(projectId).findings["ship.unreviewed"]?.state).toBe("regressed");
    expect(escalateFinding(projectId, "ship.unreviewed").ok).toBe(false); // deny is the top

    // A nudge-tier rule escalates to deny and restarts verification.
    const g = approveFinding(projectId, "graph.first.skipped");
    expect(g.ok && g.rule.tier).toBe("nudge");
    const gAt = Date.parse((g as { rule: PracticeRule }).rule.acceptedAt);
    files.set("e", { raw: badSession("2027-01-06"), mtime: gAt + 1000 });
    files.set("e2", { raw: badSession("2027-01-07"), mtime: gAt + 1500 });
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

  it("fixed in MARVIN: verified like a rule without one — quiet window confirms, a recurrence regresses", () => {
    threeBadSessions();
    expect(markFindingFixed(projectId, "ship.unreviewed", "ADR-0104 gate")).toBe(true);
    expect(markFindingFixed(projectId, "ship.reviewed", "x")).toBe(false); // successes are not fixable
    let f = readLedger(projectId).findings["ship.unreviewed"]!;
    expect(f.state).toBe("fixed");
    const fixedAt = Date.parse(f.fixedAt!);
    for (let i = 1; i <= 5; i++) files.set(`q${i}`, { raw: goodSession(`2026-09-1${i}`), mtime: fixedAt + i * 1000 });
    const rc = runPractice(projectId, { ...seams, now: fixedAt + 10_000 });
    expect(rc.confirmed).toBe(1);
    expect(readLedger(projectId).findings["ship.unreviewed"]?.state).toBe("confirmed");

    // A fix that did not hold: the rate after is the rate before. Here the
    // five quiet sessions above sit AFTER this later fix by mtime, so two
    // recurrences in seven are below half the old rate and the fix is
    // confirmed — the pane shows "2 of 7 since fix" and the user decides.
    expect(markFindingFixed(projectId, "graph.first.skipped", "pre-orientation")).toBe(true);
    const fx2 = Date.parse(readLedger(projectId).findings["graph.first.skipped"]!.fixedAt!);
    files.set("bad-again", { raw: badSession("2027-01-20"), mtime: fx2 + 1000 });
    files.set("bad-again-2", { raw: badSession("2027-01-21"), mtime: fx2 + 1500 });
    runPractice(projectId, { ...seams, now: fx2 + 2000 });
    f = readLedger(projectId).findings["graph.first.skipped"]!;
    expect(f.recurrenceAfter).toBe(2);
    expect(f.sessionsAfter).toBe(7);
    expect(f.state).toBe("confirmed");

    // On a fresh ledger with nothing quiet after the fix, two recurring
    // sessions at the old rate ARE a regression, and there is nothing to escalate.
    const p2 = "p-fix-regressed";
    runPractice(p2, { ...seams, now: day(3) + 1 });
    expect(markFindingFixed(p2, "graph.first.skipped", "pre-orientation")).toBe(true);
    const fx3 = Date.parse(readLedger(p2).findings["graph.first.skipped"]!.fixedAt!);
    files.set("bad-again", { raw: badSession("2027-01-20"), mtime: fx3 + 1000 });
    files.set("bad-again-2", { raw: badSession("2027-01-21"), mtime: fx3 + 1500 });
    runPractice(p2, { ...seams, now: fx3 + 2000 });
    f = readLedger(p2).findings["graph.first.skipped"]!;
    expect(f.state).toBe("regressed");
    expect(f.ruleId).toBeUndefined();
    expect(escalateFinding(p2, "graph.first.skipped").ok).toBe(false); // nothing to escalate
  });

  it("2026-09-09: what the extractors no longer count, and what they now do", () => {
    const denyRead = (p: string) => ({ name: "Read", input: { file_path: p }, error: "graphify-first: Read on `x` would be the first structural search" });
    const grep = (q: string) => ({ name: "Bash", input: { command: `grep -n "${q}" /p/src` } });
    const shipDeny = { name: "Bash", input: { command: "git commit -m x" }, error: "ship-review gate (ADR-0104): this commit seals 7 files, and `pr-review` has not run" };
    const commit = { name: "Bash", input: { command: "git commit -m x" } };
    const wakeup = { name: "mcp__marvin-control__schedule_wakeup", input: { seconds: 90 } };
    const cwdInit = { type: "cli.event", at: "2026-09-08T10:00:00Z", event: { type: "system", subtype: "init", cwd: "/p" } };
    const ids = (lines: Line[]) => extractAll(parseSessionTranscript("p3", jsonl([cwdInit, ...lines]))).map((o) => o.fingerprint);

    // A refused read is not a read; a wakeup turn is not judged graph-first.
    const refusedThenSix = ids(turn({ at: "2026-09-08T10:00:00Z", message: "look", tools: [denyRead("/p/src/a.ts"), ...reads(4)], text: "?" }));
    expect(refusedThenSix).not.toContain("graph.first.skipped"); // 4 real reads, under the five-read opportunity
    const wake = ids(turn({ at: "2026-09-08T10:00:00Z", message: "[scheduled wakeup — background job done]", tools: [grep("a"), ...reads(6)], text: "?" }));
    expect(wake).not.toContain("graph.first.skipped");

    // A ship-review refusal is not a command failure; the commit it let through IS unreviewed.
    const waitedOut = ids(turn({ at: "2026-09-08T10:00:00Z", message: "commit", tools: [shipDeny, shipDeny, commit], text: "Committed." }));
    expect(waitedOut).not.toContain("command.retried");
    expect(waitedOut).toContain("ship.unreviewed");
    const reviewedBetween = ids(turn({ at: "2026-09-08T10:00:00Z", message: "commit", tools: [shipDeny, { name: "Skill", input: { skill: "pr-review" } }, commit], text: "Committed." }));
    expect(reviewedBetween).not.toContain("ship.unreviewed");

    // A turn that armed a wakeup handed off, whatever it said last.
    const handoff = ids(turn({ at: "2026-09-08T10:00:00Z", message: "fix it", tools: [edit, ...filler(9), wakeup], text: "Compile is running now; I'll react to its result." }));
    expect(handoff).not.toContain("scope.met.missing");

    // A finished plan is not stale; the next HUMAN turn counts, a wakeup does not.
    const open = { name: "TodoWrite", input: { todos: [{ content: "[1] x", status: "in_progress" }] } };
    const closed = { name: "TodoWrite", input: { todos: [{ content: "[1] x", status: "completed" }] } };
    const finished = ids([
      ...turn({ at: "2026-09-08T10:00:00Z", message: "plan", tools: [open], text: "?" }),
      ...turn({ at: "2026-09-08T10:10:00Z", message: "go", tools: [edit, edit, edit, closed], text: "Done. ?" }),
      ...turn({ at: "2026-09-08T10:20:00Z", message: "docs", tools: [edit, edit, edit, edit], text: "?" }),
      ...turn({ at: "2026-09-08T10:30:00Z", message: "next", text: "?" }),
    ]);
    expect(finished).not.toContain("plan.stale");
    const viaWakeup = ids([
      ...turn({ at: "2026-09-08T10:00:00Z", message: "plan", tools: [open], text: "?" }),
      ...turn({ at: "2026-09-08T10:10:00Z", message: "go", tools: [edit, edit, edit], text: "?" }),
      ...turn({ at: "2026-09-08T10:20:00Z", message: "[scheduled wakeup — background job done]", text: "?" }),
      ...turn({ at: "2026-09-08T10:30:00Z", message: "next", tools: [open], text: "?" }),
    ]);
    expect(viaWakeup).toContain("plan.kept");
    expect(viaWakeup).not.toContain("plan.stale");

    // A skill invoked in an earlier turn is followed, not bypassed, when its files are read later.
    const later = ids([
      ...turn({ at: "2026-09-08T10:00:00Z", message: "graph", tools: [{ name: "Skill", input: { skill: "graphify" } }], text: "?" }),
      ...turn({ at: "2026-09-08T10:10:00Z", message: "update", tools: [{ name: "Read", input: { file_path: "/Users/x/.claude/skills/graphify/references/update.md" } }], text: "?" }),
    ]);
    expect(later).toContain("skill.invoked:graphify");
    expect(later).not.toContain("skill.bypassed:graphify");

    // The overbudget report says where the money went.
    const pricey = extractAll(parseSessionTranscript("p3", jsonl(turn({ at: "2026-09-08T10:00:00Z", message: "big", text: "?", costUsd: 12, cacheCreation: 480_000 }))));
    expect(pricey.find((o) => o.fingerprint === "turn.overbudget")?.detail).toContain("480k cache-creation tokens");
  });

  it("2026-09-09: sessions outside the window leave every count; reset clears the ledger and a ruled fingerprint re-attaches", () => {
    threeBadSessions();
    const led1 = readLedger(projectId);
    expect(led1.findings["ship.unreviewed"]?.distinctSessions).toBe(3);
    // Seen from 60 days after day 3, with a 45-day window, every fixture session is gone.
    const later = day(3) + 60 * 86_400_000;
    runPractice(projectId, { ...seams, now: later });
    const led2 = readLedger(projectId);
    expect(led2.findings["ship.unreviewed"]).toBeUndefined(); // aged out and pruned
    expect(Object.keys(led2.watermarks)).toHaveLength(3); // never re-read
    // The dropped sessions come back only through a backtest (the watermarks
    // protect a scheduled run from re-reading them).
    writePracticeConfig({ windowDays: 365 });
    runPractice(projectId, { ...seams, now: later, force: true });
    expect(readLedger(projectId).findings["ship.unreviewed"]?.distinctSessions).toBe(3);

    // Reset keeps the rule; the next run attaches the fingerprint to it instead of proposing again.
    const ap = approveFinding(projectId, "ship.unreviewed");
    expect(ap.ok).toBe(true);
    resetPracticeLedger(projectId);
    expect(Object.keys(readLedger(projectId).findings)).toHaveLength(0);
    expect(readRules()).toHaveLength(1);
    runPractice(projectId, { ...seams, now: later });
    const f = readLedger(projectId).findings["ship.unreviewed"]!;
    expect(f.state).toBe("active");
    expect(f.ruleId).toBe(readRules()[0]!.id);
    expect(readRules()).toHaveLength(1); // no second rule
  });

  it("2026-09-09: a namespaced failure rates against its own skill, and dismissing a ruled finding retires the rule", () => {
    const sess = (n: number) => jsonl([
      ...turn({ at: `2026-09-0${n}T10:00:00Z`, message: "a", tools: [{ name: "Skill", input: { skill: "pr-review" } }], text: "?" }),
      ...turn({ at: `2026-09-0${n}T11:00:00Z`, message: "b", tools: [{ name: "Read", input: { file_path: "/Users/x/.claude/skills/hetzner-ssh/SKILL.md" } }], text: "?" }),
    ]);
    for (let i = 1; i <= 3; i++) files.set(`s${i}`, { raw: sess(i), mtime: day(i) });
    runPractice(projectId, { ...seams, now: day(3) + 1 });
    const led = readLedger(projectId);
    expect(led.findings["skill.bypassed:hetzner-ssh"]?.rate).toBe(1); // no hetzner-ssh invocations: 3 of 3
    expect(led.findings["skill.invoked:pr-review"]?.distinctSessions).toBe(3);
    expect(led.findings["skill.bypassed:hetzner-ssh"]?.state).toBe("proposed");
    const ap = approveFinding(projectId, "skill.bypassed:hetzner-ssh");
    expect(ap.ok).toBe(true);
    expect(dismissFinding(projectId, "skill.bypassed:hetzner-ssh", "reads are fine here")).toBe(true);
    expect(readRules()[0]?.status).toBe("retired");
    expect(readLedger(projectId).findings["skill.bypassed:hetzner-ssh"]?.ruleId).toBeUndefined();
  });

  it("a dismissal can be undone by hand, the same way recurrence undoes it", () => {
    // Dismissing was a one-way door: one click behind a required reason, and
    // the only way back was waiting for the finding to recur in twice as many
    // sessions (2026-09-11). Undo is deliberately that same transition.
    threeBadSessions();
    expect(dismissFinding(projectId, "graph.first.skipped", "scouting is fine here")).toBe(true);
    expect(readLedger(projectId).findings["graph.first.skipped"]?.state).toBe("dismissed");

    expect(undismissFinding(projectId, "graph.first.skipped").ok).toBe(true);

    const f = readLedger(projectId).findings["graph.first.skipped"];
    expect(f?.state).toBe("observed");
    expect(f?.dismissedAt).toBeUndefined();
    expect(f?.dismissReason).toBeUndefined();
    expect(f?.dismissedAtSessions).toBeUndefined();
    // And the next run is free to promote it again, exactly as before.
    runPractice(projectId, { ...seams, now: day(3) + 2 });
    expect(readLedger(projectId).findings["graph.first.skipped"]?.state).toBe("proposed");
  });

  it("undo refuses what it cannot undo, and says which", () => {
    threeBadSessions();
    expect(undismissFinding(projectId, "graph.first.skipped").ok).toBe(false);
    expect(undismissFinding(projectId, "graph.first.skipped").reason).toContain("not dismissed");
    expect(undismissFinding(projectId, "no.such.finding").reason).toBe("no such finding");
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

describe("the 2026-09-04 false regressions (three extractor blind spots)", () => {
  const ids = (raw: string) => extractAll(parseSessionTranscript("fr", raw)).map((o) => o.fingerprint).sort();
  const realWork = [edit, ...filler(10)];

  it("a stated scope-NOT-met handoff is a handoff, not a missing one", () => {
    for (const text of [
      "**Not done yet — here's what remains.** Verified the fix; the fast suite is still running in the background.",
      "**Not scope met — verification is still running.** I will report when it finishes.",
      "Scope is not met: the migration has not been run on staging yet.",
    ]) {
      expect(classifyTurnEnding(text)).toBe("scope-not-met");
      const one = ids(jsonl(turn({ at: "2026-09-01T10:00:00Z", message: "fix it", tools: realWork, text })));
      expect(one).not.toContain("scope.met.missing");
      expect(one).not.toContain("scope.met.present");
    }
    // …and it is a boundary the user continued from, like scope-met.
    const two = ids(
      jsonl([
        ...turn({ at: "2026-09-01T10:00:00Z", message: "fix it", tools: realWork, text: "**Not done yet.** Tests still running.", endAt: "2026-09-01T10:05:00Z" }),
        ...turn({ at: "2026-09-01T10:10:00Z", message: "ok, wait for them", text: "Waiting." }),
      ]),
    );
    expect(two).toContain("turn.continued");
    expect(two).not.toContain("turn.stalled");
    // A plain stop is still a stop.
    expect(classifyTurnEnding("Done, files updated.")).toBe("stopped");
  });

  it("reading a skill's folder in the turn that edits that skill is maintenance, not a bypass", () => {
    const skillFile = "/p/.marvin/skills/hetzner-ssh/SKILL.md";
    const maintained = jsonl(
      turn({
        at: "2026-09-01T10:00:00Z",
        message: "fix the hetzner-ssh skill's sudo note",
        tools: [
          { name: "Bash", input: { command: `cat ${skillFile} | sed -n '1,40p'` } },
          { name: "Read", input: { file_path: skillFile } },
          { name: "Edit", input: { file_path: skillFile, old_string: "a", new_string: "b" } },
        ],
        text: "ok?",
      }),
    );
    expect(ids(maintained)).not.toContain("skill.bypassed:hetzner-ssh");
    // Editing some OTHER skill does not excuse the read.
    const other = jsonl(
      turn({
        at: "2026-09-01T10:00:00Z",
        message: "m",
        tools: [
          { name: "Read", input: { file_path: skillFile } },
          { name: "Edit", input: { file_path: "/p/.marvin/skills/other/SKILL.md" } },
        ],
        text: "ok?",
      }),
    );
    expect(ids(other)).toContain("skill.bypassed:hetzner-ssh");
  });

  it("the runtime's pre-orientation counts as the turn's first graph call", () => {
    const at = "2026-09-01T10:00:00Z";
    const lines = turn({ at, message: "where is the login flow wired?", tools: reads(6), text: "ok?" });
    const preorient = {
      type: "cli.event",
      at,
      event: { type: "system", subtype: PREORIENT_SUBTYPE, turnId: `t-${at}`, query: "login flow", hits: 5, at },
    };
    // Same turn without the event: six reads before any graph call.
    expect(ids(jsonl(lines))).toContain("graph.first.skipped");
    // With it, spliced in right after turn.started (where the runner emits it).
    const oriented = [...lines.slice(0, 2), preorient, ...lines.slice(2)];
    const got = ids(jsonl(oriented));
    expect(got).toContain("graph.first.followed");
    expect(got).not.toContain("graph.first.skipped");
  });
});

describe("plan shape — tracer bullets against the project's own areas (2026-09-07)", () => {
  // A fixture of DISCOVERED areas: names are the project's paths, vocab its
  // own (stemmed) words. Nothing here is MARVIN's assumption.
  const areas = {
    fileCount: 11,
    areas: [
      { name: "apps/api", files: 4, vocab: ["api", "controller", "endpoint", "migration", "repository"], structural: ["api", "endpoint", "migration"] },
      { name: "apps/web", files: 4, vocab: ["web", "page", "component", "hook"], structural: ["web", "page", "component"] },
    ],
  };
  const horizontal = ["[1] Migration for the orders table", "[2] Orders endpoint in the controller", "[3] Orders page with the OrderRow component"];
  const vertical = ["[1] Thin slice: migration + endpoint + Orders page renders one row", "[2] Validation and error states", "[3] Pagination"];
  const todoOf = (titles: string[], parent?: string) => ({
    name: "TodoWrite",
    input: { todos: titles.map((content) => ({ content, status: "pending" })) },
    ...(parent ? { parent } : {}),
  });
  const ids = (raw: string, a: typeof areas | null = areas) =>
    extractAll(parseSessionTranscript("ps", raw), { areas: a }).map((o) => o.fingerprint).sort();

  it("classifies horizontal, vertical, single-layer and unknown plans", () => {
    const h = classifyPlanShape(horizontal, areas);
    expect(h.shape).toBe("horizontal");
    expect(h.layersPerStep).toEqual([["apps/api"], ["apps/api"], ["apps/web"]]);
    expect(h.layers).toEqual(["apps/api", "apps/web"]);
    expect(h.firstCrossStep).toBeNull();
    const v = classifyPlanShape(vertical, areas);
    expect(v.shape).toBe("vertical");
    expect(v.firstCrossStep).toBe(1);
    expect(classifyPlanShape(["[1] Fix the OrdersPage layout", "[2] add the component tooltip"], areas).shape).toBe("single-layer");
    expect(classifyPlanShape(["[1] update README"], areas).shape).toBe("unknown");
    // Two steps in two areas: too little to call.
    expect(classifyPlanShape(horizontal.slice(1), areas).shape).toBe("unknown");
    // No areas known: never a verdict.
    expect(classifyPlanShape(horizontal, null).shape).toBe("unknown");
    expect(classifyPlanShape(horizontal, { fileCount: 3, areas: areas.areas.slice(0, 1) }).shape).toBe("unknown");
  });

  it("verification wording and a late test step do not flip a plan; a late end-to-end step does", () => {
    const suffixed = horizontal.map((t) => `${t} — verify: typecheck + manual smoke on /orders`);
    expect(classifyPlanShape(suffixed, areas).shape).toBe("horizontal");
    expect(classifyPlanShape([...horizontal, "[4] add e2e tests"], areas).shape).toBe("horizontal");
    const late = classifyPlanShape([...horizontal, "[4] end-to-end: create an order from the page and read it back"], areas);
    expect(late.shape).toBe("vertical");
    expect(late.firstCrossStep).toBe(4);
    // Process steps neither cross nor add a layer, even when they name every area's tooling.
    const shipped = [...horizontal, "[4] Verify & ship: typecheck, page tests, endpoint tests, pr-review"];
    expect(classifyPlanShape(shipped, areas).shape).toBe("horizontal");
    expect(classifyPlanShape(["[1] Write the ADR", "[2] Tests: page + endpoint", "[3] Ship"], areas).shape).toBe("unknown");
    // Crossing needs structural evidence: a domain noun from a file stem does not cross.
    const nouns = ["[1] Orders migration", "[2] Orders endpoint", "[3] Orders page listing the controller output"];
    expect(classifyPlanShape(nouns, areas).layersPerStep[2]).toEqual(["apps/api", "apps/web"]);
    expect(classifyPlanShape(nouns, areas).shape).toBe("horizontal");
    // A weak marker needs an area in the same step.
    expect(classifyPlanShape(["[1] Wire up logging to stdout", "[2] endpoint", "[3] page"], areas).firstCrossStep).toBeNull();
    expect(classifyPlanShape(["[1] Wire the Orders page to the endpoint", "[2] x", "[3] y"], areas).firstCrossStep).toBe(1);
  });

  it("planStepsOf mirrors the app's tag grammar: sorted by N, first title per N, sub-tasks dropped", () => {
    const todos = ["[2] c", "[1] a", "[1.1] b", "[1] a again", "no tag", "[2.3] d", "[3]"].map((content) => ({ content, status: "pending" }));
    expect(planStepsOf(todos)).toEqual(["a", "c", ""]);
    expect(planStepsOf([{ content: "[1.1] x" }, { content: "[1.2] y" }])).toEqual([]);
    expect(planStepsOf(undefined)).toEqual([]);
    expect(planStepsOf("str")).toEqual([]);
    expect(planStepsOf([{ content: "", activeForm: "[1] from activeForm" }])).toEqual(["from activeForm"]);
  });

  it("emits one occurrence per distinct plan, at its first TodoWrite, and lets a same-turn re-slice supersede", () => {
    const at = "2026-09-01T10:00:00Z";
    const thrice = jsonl(turn({ at, message: "build orders", tools: [todoOf(horizontal), edit, todoOf(horizontal), todoOf(horizontal)], text: "ok?" }));
    const occ = extractAll(parseSessionTranscript("ps", thrice), { areas });
    const h = occ.filter((o) => o.fingerprint === "plan.horizontal");
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ cost: 1, at });
    expect(h[0]?.detail).toBe("3 layer-only milestones (apps/api → apps/web), first cross-layer step: none");
    const v = extractAll(parseSessionTranscript("ps", jsonl(turn({ at, message: "m", tools: [todoOf(vertical)], text: "ok?" }))), { areas });
    expect(v.find((o) => o.fingerprint === "plan.vertical")?.detail).toBe("milestone 1 crosses apps/api + apps/web");
    // Same turn: horizontal then vertical → only the vertical (the nudge held).
    expect(ids(jsonl(turn({ at, message: "m", tools: [todoOf(horizontal), todoOf(vertical)], text: "ok?" })))).toEqual(["plan.vertical"]);
    // Across turns both stand.
    const across = jsonl([
      ...turn({ at, message: "m", tools: [todoOf(horizontal)], text: "ok?" }),
      ...turn({ at: "2026-09-01T11:00:00Z", message: "re-slice it", tools: [todoOf(vertical)], text: "ok?" }),
    ]);
    expect(ids(across)).toEqual(["plan.horizontal", "plan.vertical", "turn.continued"]);
    // A subagent's TodoWrite, a two-step plan, and no areas: nothing.
    expect(ids(jsonl(turn({ at, message: "m", tools: [todoOf(horizontal, "toolu_sub")], text: "ok?" })))).toEqual([]);
    expect(ids(jsonl(turn({ at, message: "m", tools: [todoOf(horizontal.slice(1))], text: "ok?" })))).toEqual([]);
    expect(ids(jsonl(turn({ at, message: "m", tools: [todoOf(horizontal)], text: "ok?" })), null)).toEqual([]);
  });

  it("a nudge-tier rule fires once on a horizontal TodoWrite and on nothing else", () => {
    const projectId = "p-shape";
    const now = "2026-09-07T00:00:00.000Z";
    const rule: PracticeRule = {
      id: "r-shape",
      fingerprint: "plan.horizontal",
      title: "slice",
      tier: "nudge",
      trigger: { tool: "^TodoWrite$", planShape: "horizontal" },
      message: "slice it",
      status: "active",
      scope: { projectId },
      provenance: { findingId: "plan.horizontal", distinctSessions: 3, costTotal: 3, value: 0.8 },
      metrics: { fired: 0, lastFiredAt: null, bypasses: 0 },
      createdAt: now,
      acceptedAt: now,
      updatedAt: now,
    };
    const ctx = (input: Record<string, unknown>, toolName = "TodoWrite") => ({
      projectId,
      toolName,
      input,
      counters: {},
      hasSkillRun: () => false,
      boundaryHit: () => false,
      areas: () => areas,
      deniesThisTurn: new Map<string, number>(),
      nudgesThisTurn: new Set<string>(),
      measure: false,
    });
    const todos = (titles: string[]) => ({ todos: titles.map((content) => ({ content, status: "pending" })) });
    const c = ctx(todos(horizontal));
    expect(evaluatePracticeRules(c, [rule]).nudges.map((n) => n.message)).toEqual(["slice it"]);
    expect(evaluatePracticeRules(c, [rule]).nudges).toEqual([]); // once per turn
    expect(evaluatePracticeRules(ctx(todos(vertical)), [rule]).nudges).toEqual([]);
    expect(evaluatePracticeRules(ctx(todos(horizontal), "Edit"), [rule]).nudges).toEqual([]);
    expect(evaluatePracticeRules({ ...ctx(todos(horizontal)), areas: () => null }, [rule]).nudges).toEqual([]);
  });
});

describe("the 2026-09-07 practice report — two more extractor blind spots", () => {
  const at = "2026-09-01T10:00:00Z";
  const init = (cwd: string) => ({ type: "cli.event", at, event: { type: "system", subtype: "init", cwd } });
  const ids = (raw: string) => extractAll(parseSessionTranscript("r2", raw)).map((o) => o.fingerprint).sort();
  const bash = (command: string) => ({ name: "Bash", input: { command } });

  it("a source read is what the gate says it is: search-shaped Bash inside the project, not cat on a doc or a find under ~", () => {
    const lines = turn({ at, message: "close the backlog items", tools: [
      bash("grep -n 'seal' /p/docs/adr/0377.md"),
      bash("cat /p/docs/runbooks/x.md"),
      bash("sed -n '355,395p' /p/docs/adr/0377.md"),
      bash("find /Users/x/.claude/skills/graphify -iname spec.md"),
      bash("cat /p/.marvin/backlog/a.md"),
      bash("cd /p\nPY=$(cat graphify-out/.graphify_python)\n\"$PY\" -c 'x'"),
      { name: "Read", input: { file_path: "/p/docs/adr/0046.md" } },
      { name: "Read", input: { file_path: "/elsewhere/src/a.ts" } },
    ], text: "ok?" });
    const parsed = parseSessionTranscript("r2", jsonl([...lines.slice(0, 2), init("/p"), ...lines.slice(2)]));
    expect(parsed.cwd).toBe("/p");
    // Only the grep (a search whose root is inside cwd) counts: one read, well under five.
    expect(extractAll(parsed).map((o) => o.fingerprint)).not.toContain("graph.first.skipped");
    // Five tree searches inside the project still do.
    const searching = turn({ at, message: "m", tools: Array.from({ length: 5 }, (_, i) => bash(`rg "thing${i}" src/`)), text: "ok?" });
    expect(ids(jsonl([...searching.slice(0, 2), init("/p"), ...searching.slice(2)]))).toContain("graph.first.skipped");
    // Without an init event the cwd is unknown: source-extension Reads still count, Bash never does.
    expect(ids(jsonl(turn({ at, message: "m", tools: reads(5), text: "ok?" })))).toContain("graph.first.skipped");
    expect(ids(jsonl(turn({ at, message: "m", tools: Array.from({ length: 5 }, () => bash("rg x src/")), text: "ok?" })))).not.toContain("graph.first.skipped");
  });

  it("a review's report excludes the echoed skill body and stops at the commit; a clean report is not findings", () => {
    const skill = { name: "Skill", input: { skill: "pr-review" } };
    const body = "Base directory for this skill: /Users/x/.claude/skills/pr-review\n# Pre-landing review\n🔴 Important — must fix before merge";
    // The real 2026-09-03 turn: skill body echoed, "0 important", commit, then "3 CRITICAL CVEs" in the summary.
    const lines = [
      ...turn({ at, message: "ship", tools: [edit, skill], text: body }),
    ];
    // Splice a second text block, a commit, and a later text block into the same turn.
    const extra = [
      { type: "cli.event", at, event: { type: "assistant", message: { content: [{ type: "text", text: "**0 important, 0 nit, 0 pre-existing.** Diff is entirely prose. Committing." }] } } },
      { type: "cli.event", at, event: { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_c1", name: "Bash", input: { command: "git commit -m x" } }] } } },
      { type: "cli.event", at, event: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_c1", content: "ok" }] } } },
      { type: "cli.event", at, event: { type: "assistant", message: { content: [{ type: "text", text: "Done. Earlier bump covered 3 CRITICAL CVEs." }] } } },
    ];
    const completed = lines.pop()!; // turn.completed stays last
    const got = ids(jsonl([...lines, ...extra, completed]));
    expect(got).not.toContain("review.ignored");
    expect(got).not.toContain("review.acted");
    // A real report right after the review still counts.
    expect(ids(jsonl(turn({ at, message: "ship", tools: [edit, skill], text: "**2 important, 1 nit.** [Important] SQL built by concat." })))).toContain("review.ignored");
  });
});
