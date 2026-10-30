import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ActionLimiter,
  evaluateAnswer,
  type GroundContext,
  questionHeuristic,
  resolveGround,
} from "../src/supervisor-policy";
import { DEFAULT_CAPS } from "../src/supervisor-state";

// ADR-0127 §3 — every act carries grounds that must resolve and carry
// provenance; §4 — the question heuristic is a heuristic, labelled and
// counted; §6 — rate limits, duplicate drop and the per-wake breaker.

let main: string;
let tab: string;
let ctx: GroundContext;
const tabStart = Date.parse("2026-10-30T12:00:00Z");

beforeEach(() => {
  main = mkdtempSync(path.join(tmpdir(), "marvin-sup-main-"));
  tab = mkdtempSync(path.join(tmpdir(), "marvin-sup-tab-"));
  mkdirSync(path.join(main, "docs", "decisions"), { recursive: true });
  writeFileSync(path.join(main, "docs", "decisions", "0042-memory-as-durable-facts.md"), "# 42\n");
  mkdirSync(path.join(tab, "docs", "decisions"), { recursive: true });
  writeFileSync(path.join(tab, "docs", "decisions", "0200-tab-wrote-this.md"), "# 200\n");
  mkdirSync(path.join(main, ".marvin", "memory"), { recursive: true });
  writeFileSync(path.join(main, ".marvin", "memory", "old-fact.md"), "x");
  utimesSync(path.join(main, ".marvin", "memory", "old-fact.md"), new Date(tabStart - 86_400_000), new Date(tabStart - 86_400_000));
  writeFileSync(path.join(main, ".marvin", "memory", "new-fact.md"), "x");
  utimesSync(path.join(main, ".marvin", "memory", "new-fact.md"), new Date(tabStart + 60_000), new Date(tabStart + 60_000));
  mkdirSync(path.join(main, "src"), { recursive: true });
  writeFileSync(path.join(main, "src", "a.ts"), "one\ntwo\nthree\n");
  mkdirSync(path.join(tab, "src"), { recursive: true });
  writeFileSync(path.join(tab, "src", "b.ts"), "x\n");
  ctx = {
    mainRoot: main,
    tabRoot: tab,
    charter: "Ship the billing page. Postgres, not SQLite.",
    brief: "Build the billing page.\n## Definition of Done\n- invoices list renders",
    planStepCount: 4,
    planSeeded: true,
    tabStartedAt: tabStart,
  };
});
afterEach(() => {
  rmSync(main, { recursive: true, force: true });
  rmSync(tab, { recursive: true, force: true });
});

describe("grounds — resolution and provenance", () => {
  it.each([
    ["an ADR on the main checkout", { kind: "adr", ref: "ADR-0042" }, "strong"],
    ["an ADR by bare number", { kind: "adr", ref: "0042" }, "strong"],
    ["an ADR only the tab wrote", { kind: "adr", ref: "0200" }, "weak"],
    ["an ADR that does not exist", { kind: "adr", ref: "0999" }, "unresolved"],
    ["a quote from the user's charter", { kind: "charter", ref: "Postgres, not SQLite" }, "strong"],
    ["a 'quote' the charter does not contain", { kind: "charter", ref: "use MongoDB" }, "unresolved"],
    ["a DoD bullet from the user's brief", { kind: "dod", ref: "invoices list renders" }, "strong"],
    ["a DoD bullet the brief does not contain", { kind: "dod", ref: "deploy to prod" }, "unresolved"],
    ["a step of a plan seeded from the user's brief", { kind: "plan", ref: "3" }, "strong"],
    ["a step beyond the plan", { kind: "plan", ref: "9" }, "unresolved"],
    ["a memory fact older than the tab", { kind: "memory", ref: "old-fact" }, "strong"],
    ["a memory fact the tab wrote itself", { kind: "memory", ref: "new-fact" }, "weak"],
    ["a memory fact that does not exist", { kind: "memory", ref: "nope" }, "unresolved"],
    ["a file:line on the main checkout", { kind: "file", ref: "main:src/a.ts:2" }, "strong"],
    ["a line past the end of the file", { kind: "file", ref: "main:src/a.ts:40" }, "unresolved"],
    ["a file in the tab's own tree", { kind: "file", ref: "tab:src/b.ts" }, "weak"],
    ["a path that escapes the tree", { kind: "file", ref: "main:../../etc/passwd" }, "unresolved"],
    ["a path-shaped memory slug", { kind: "memory", ref: "../../secret" }, "unresolved"],
  ] as const)("%s → %s", (_name, ground, provenance) => {
    expect(resolveGround(ground, ctx).provenance).toBe(provenance);
  });

  it("a plan the tab presented itself (not seeded from the brief) is weak", () => {
    expect(resolveGround({ kind: "plan", ref: "2" }, { ...ctx, planSeeded: false }).provenance).toBe("weak");
  });
});

describe("the question heuristic — labelled, not complete", () => {
  it.each([
    ["Should I push the branch now?", "push"],
    ["Open a merge request for review?", "merge request"],
    ["Run the migration against staging?", "migration"],
    ["Rotate the API key in .env?", ".env"],
    ["Shall I approve the plan and proceed?", "approve the plan"],
    ["Deploy to production?", "deploy"],
  ])("%s → flags %s", (q, term) => {
    expect(questionHeuristic([q])).toBe(term);
  });

  it("leaves an ordinary design question alone", () => {
    expect(questionHeuristic(["Which table name: invoices or bills?", "invoices", "bills"])).toBeNull();
  });
});

describe("evaluateAnswer — the answer verb's decision", () => {
  const base = () => ({
    mode: "shadow" as const,
    delegation: "answer-questions" as const,
    targetIsSupervisor: false,
    questionTexts: ["Which database: Postgres or SQLite?", "Postgres", "SQLite"],
    grounds: [{ kind: "charter" as const, ref: "Postgres, not SQLite" }],
    groundCtx: ctx,
  });

  it("a grounded answer in shadow mode is a proposal, with provenance on each ground", () => {
    const out = evaluateAnswer(base());
    expect(out.decision).toBe("propose");
    expect(out.grounds).toEqual([{ kind: "charter", ref: "Postgres, not SQLite", provenance: "strong" }]);
  });

  it("an ungrounded answer is refused", () => {
    const out = evaluateAnswer({ ...base(), grounds: [] });
    expect(out.decision).toBe("refuse");
    expect(out.reason).toMatch(/no grounds/i);
  });

  it("an answer whose citation does not resolve is refused, naming it", () => {
    const out = evaluateAnswer({ ...base(), grounds: [{ kind: "adr", ref: "0999" }] });
    expect(out.decision).toBe("refuse");
    expect(out.reason).toMatch(/0999/);
  });

  it("an answer with only weak grounds escalates", () => {
    const out = evaluateAnswer({ ...base(), grounds: [{ kind: "memory", ref: "new-fact" }] });
    expect(out.decision).toBe("escalate");
    expect(out.reason).toMatch(/weak/i);
  });

  it("a heuristic-flagged question escalates even with strong grounds, and says the heuristic fired", () => {
    const out = evaluateAnswer({ ...base(), questionTexts: ["Push to origin now?", "Yes", "No"] });
    expect(out.decision).toBe("escalate");
    expect(out.heuristic).toBe("push");
  });

  it("observe delegation cannot answer, but can escalate", () => {
    expect(evaluateAnswer({ ...base(), delegation: "observe" }).decision).toBe("refuse");
    expect(evaluateAnswer({ ...base(), delegation: "observe", escalate: { reason: "plan is silent" } }).decision).toBe("escalate");
  });

  it("an undelegated tab and a supervisor target are refused", () => {
    expect(evaluateAnswer({ ...base(), delegation: undefined }).decision).toBe("refuse");
    const rec = evaluateAnswer({ ...base(), targetIsSupervisor: true });
    expect(rec.decision).toBe("refuse");
    expect(rec.reason).toMatch(/supervisor/i);
  });

  it("an off supervisor does nothing", () => {
    expect(evaluateAnswer({ ...base(), mode: "off" }).decision).toBe("refuse");
  });
});

describe("ActionLimiter — duplicate drop, rate limits, per-wake breaker", () => {
  let t = 0;
  const limiter = () => new ActionLimiter(() => ({ ...DEFAULT_CAPS, perTabActsPer10Min: 3, globalActsPer10Min: 4, maxActionsPerWake: 2 }), () => t);
  beforeEach(() => {
    t = 1_000_000;
  });

  it("drops an identical act inside the window, and allows it after", () => {
    const l = limiter();
    expect(l.check("p", "tab", "k1", 0).ok).toBe(true);
    l.record("p", "tab", "k1");
    const dup = l.check("p", "tab", "k1", 0);
    expect(dup.ok).toBe(false);
    expect(dup.ok ? "" : dup.reason).toMatch(/duplicate/i);
    t += 11 * 60_000;
    expect(l.check("p", "tab", "k1", 0).ok).toBe(true);
  });

  it("caps acts per tab and across the project in a ten-minute window", () => {
    const l = limiter();
    for (const k of ["a", "b", "c"]) l.record("p", "tab1", k);
    expect(l.check("p", "tab1", "d", 0).ok).toBe(false);
    l.record("p", "tab2", "e");
    const g = l.check("p", "tab3", "f", 0);
    expect(g.ok).toBe(false);
    expect(g.ok ? "" : g.reason).toMatch(/project/i);
  });

  it("the per-wake breaker stops a wake after its action cap", () => {
    const b = limiter().check("p", "tab", "z", 2);
    expect(b.ok).toBe(false);
    expect(b.ok ? "" : b.reason).toMatch(/breaker/i);
  });
});
