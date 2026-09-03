import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-phases-"));

import {
  adoptRule,
  DEFAULT_PRACTICE_CONFIG,
  type LedgerFinding,
  type Ledger,
  practiceView,
  readPracticeConfig,
  scoreFinding,
  writeLedger,
  writePracticeConfig,
  writeRules,
  type PracticeRule,
} from "../src/practice";
import { applyFittedWeights, collectFitSamples, fitWeights, MIN_LABELLED_FOR_FIT, spearman, type FitSample } from "../src/practice-fit";
import { buildDraftPacket, draftPracticeMessage, parseDraft, renderDraftPrompt } from "../src/practice-draft";
import { addProject } from "../src/projects";

function finding(id: string, partial: Partial<LedgerFinding>): LedgerFinding {
  return {
    id,
    kind: id.split(":")[0] as LedgerFinding["kind"],
    polarity: "failure",
    state: "observed",
    extractorVersion: 3,
    firstSeen: "2026-09-01T00:00:00Z",
    lastSeen: "2026-09-02T00:00:00Z",
    sessions: { a: { count: 1, cost: 1, lastAt: "2026-09-02T00:00:00Z", detail: "d", mtime: 1 } },
    distinctSessions: 1,
    costTotal: 1,
    rate: null,
    value: 0.5,
    ...partial,
  };
}
function ledger(projectId: string, findings: LedgerFinding[]): Ledger {
  return {
    version: 1,
    projectId,
    extractorVersion: 3,
    watermarks: {},
    findings: Object.fromEntries(findings.map((f) => [f.id, f])),
    runs: [],
  };
}
function rule(partial: Partial<PracticeRule>): PracticeRule {
  const now = new Date().toISOString();
  return {
    id: "r",
    fingerprint: "ship.unreviewed",
    title: "t",
    tier: "deny",
    trigger: null,
    message: "m",
    status: "active",
    scope: { projectId: "p1" },
    provenance: { findingId: "ship.unreviewed", distinctSessions: 3, costTotal: 3, value: 0.8 },
    metrics: { fired: 0, lastFiredAt: null, bypasses: 0 },
    createdAt: now,
    acceptedAt: now,
    updatedAt: now,
    ...partial,
  };
}

describe("phase 5 — learned weights", () => {
  beforeEach(() => writePracticeConfig({ ...DEFAULT_PRACTICE_CONFIG, fit: undefined }));
  afterAll(() => rmSync(process.env.MARVIN_DATA_DIR!, { recursive: true, force: true }));

  it("scoreFactors + weights reproduce the pinned worked examples", () => {
    expect(scoreFinding({ kind: "ship.unreviewed", distinctSessions: 3, costTotal: 3, rate: 1, sessionsSinceLastSeen: 0 }, DEFAULT_PRACTICE_CONFIG)).toBeCloseTo(0.89, 2);
  });

  it("spearman is 1 on a monotone pair, 0 when degenerate", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 6);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 6);
    expect(spearman([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
  });

  it("with enough labels the fit raises the weight of the factor that predicts the outcome, and sums to one", () => {
    const samples: FitSample[] = [];
    for (let i = 0; i < 12; i++) {
      const cost = i / 11; // the costly ones were the ones that got confirmed
      samples.push({
        projectId: "p",
        findingId: `f${i}`,
        factors: { recurrence: 0.5, cost, rate: 1 - cost, reliability: 1, actionability: 1, decay: 0 },
        label: cost > 0.5 ? 1 : 0,
        costShare: 1 / 12,
      });
    }
    // Start from weights that rank the WRONG way (rate dominates, cost barely
    // counts), so the fit has something to correct.
    const wrong = { ...DEFAULT_PRACTICE_CONFIG.weights, rate: 0.6, cost: 0.05 };
    const fit = fitWeights(samples, wrong);
    expect(fit.method).toBe("spearman-labels");
    expect(fit.labelled).toBe(12);
    expect(fit.rhoBefore).toBeLessThan(0);
    expect(fit.weights.cost).toBeGreaterThan(wrong.cost);
    expect(fit.rhoAfter).toBeGreaterThanOrEqual(fit.rhoBefore);
    const sum = fit.weights.recurrence + fit.weights.cost + fit.weights.rate + fit.weights.reliability + fit.weights.actionability;
    expect(sum).toBeCloseTo(1, 2);
  });

  it("below the label floor it ranks by cost share instead, and nothing is written until applied", () => {
    writeLedger(ledger("p-fit", [
      finding("ship.unreviewed", { state: "confirmed", distinctSessions: 4, costTotal: 4 }),
      finding("turn.stalled", { state: "dismissed", distinctSessions: 2, costTotal: 200 }),
      finding("graph.first.skipped", { distinctSessions: 3, costTotal: 30 }),
    ]));
    const samples = collectFitSamples(["p-fit"]);
    expect(samples).toHaveLength(3);
    expect(samples.filter((s) => s.label !== null)).toHaveLength(2);
    const fit = fitWeights(samples, DEFAULT_PRACTICE_CONFIG.weights);
    expect(fit.method).toBe("rank-cost-share");
    expect(fit.labelled).toBeLessThan(MIN_LABELLED_FOR_FIT);
    expect(readPracticeConfig().fit).toBeUndefined();
    const cfg = applyFittedWeights(fit);
    expect(cfg.fit?.method).toBe("rank-cost-share");
    expect(readPracticeConfig().weights).toEqual(fit.weights);
  });
});

describe("phase 6 — promotion suggestions", () => {
  beforeEach(() => writeRules([]));

  it("suggests global when the same fingerprint is confirmed in two projects, not otherwise", () => {
    writeLedger(ledger("p1", [finding("ship.unreviewed", { state: "confirmed", ruleId: "r" })]));
    writeLedger(ledger("p2", [finding("ship.unreviewed", { state: "confirmed" })]));
    writeLedger(ledger("p3", [finding("ship.unreviewed", { state: "observed" })]));
    writeRules([rule({ id: "r", scope: { projectId: "p1" } })]);
    const v = practiceView("p1");
    const r = v.rules.find((x) => x.id === "r");
    expect(r?.suggestGlobal).toBe(true);
    expect(r?.confirmedIn).toBe(2);
    // Only confirmed here → no suggestion.
    writeLedger(ledger("p2", [finding("ship.unreviewed", { state: "regressed" })]));
    expect(practiceView("p1").rules.find((x) => x.id === "r")?.suggestGlobal).toBeUndefined();
    // Already global → never suggested.
    writeRules([rule({ id: "r", scope: { projectId: null } })]);
    expect(practiceView("p1").rules.find((x) => x.id === "r")?.suggestGlobal).toBeUndefined();
  });
});

describe("cold start — starter rules from other projects", () => {
  beforeEach(() => writeRules([]));

  it("offers a project-scoped rule confirmed elsewhere, adopts it as a copy scoped here with its own clock", () => {
    writeLedger(ledger("old", [finding("command.retried", { state: "confirmed", ruleId: "r-old" })]));
    writeLedger(ledger("brand-new", []));
    writeRules([rule({ id: "r-old", fingerprint: "command.retried", title: "Change before re-running", tier: "nudge", scope: { projectId: "old" } })]);
    const v = practiceView("brand-new");
    expect(v.sessionsSeen).toBe(0);
    expect(v.starters.map((s) => s.fingerprint)).toEqual(["command.retried"]);
    expect(v.starters[0]?.confirmedIn).toEqual(["old"]);

    const res = adoptRule("brand-new", "r-old");
    expect(res.ok).toBe(true);
    const mine = practiceView("brand-new");
    expect(mine.starters).toEqual([]);
    const adopted = mine.rules.find((r) => r.scope.projectId === "brand-new");
    expect(adopted?.fingerprint).toBe("command.retried");
    expect(adopted?.id).not.toBe("r-old");
    expect(mine.findings.find((f) => f.id === "command.retried")?.state).toBe("active");
    // Twice is refused; a global rule is never offered (it already applies).
    expect(adoptRule("brand-new", "r-old").ok).toBe(false);
    writeRules([rule({ id: "g", fingerprint: "turn.stalled", scope: { projectId: null } })]);
    expect(practiceView("brand-new").starters).toEqual([]);
  });
});

describe("phase 4 — model-drafted message (user-triggered)", () => {
  beforeEach(() => writeRules([])); // the packet prefers an active rule's message; start clean
  it("builds a packet from aggregates only, never transcript text, and parses the model's two lines", async () => {
    addProject({ name: "draft-proj", workDir: process.env.MARVIN_DATA_DIR! });
    const projectId = "p-draft";
    writeLedger(ledger(projectId, [
      finding("turn.stalled", { state: "proposed", distinctSessions: 5, costTotal: 9000, rate: 0.2,
        sessions: { s1: { count: 1, cost: 9000, lastAt: "2026-09-02T00:00:00Z", detail: "ended without a question; user replied \"continue\" after 9000s", mtime: 1 } } }),
    ]));
    const packet = buildDraftPacket(projectId, "turn.stalled");
    expect(packet?.distinctSessions).toBe(5);
    expect(packet?.currentMessage).toContain("CONTINUE");
    const prompt = renderDraftPrompt(packet!);
    expect(prompt).toContain("5 distinct sessions");
    expect(prompt).not.toMatch(/tool_use|turn\.user|cli\.event/);

    const res = await draftPracticeMessage({
      projectId,
      findingId: "turn.stalled",
      dispatch: async (p) => ({ text: `Message: Keep going until the plan ends. (${p.length > 0 ? "ok" : ""})\nRationale: short.`, costUsd: 0.01 }),
    });
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Keep going");
    expect(res.rationale).toBe("short.");
    expect(parseDraft("garbage")).toBeNull();
    const bad = await draftPracticeMessage({ projectId, findingId: "turn.stalled", dispatch: async () => ({ text: "nope" }) });
    expect(bad.ok).toBe(false);
    expect((await draftPracticeMessage({ projectId, findingId: "nope", dispatch: async () => ({ text: "" }) })).ok).toBe(false);
  });
});
