import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendLedgerEntry, type LedgerEntryInput, readLedger } from "../src/supervisor-ledger";
import {
  applySupervisorAction,
  bootSupervisor,
  currentSupervisorToken,
  getSupervisorState,
  noteSupervisorTabSpend,
  resetSupervisorStateForTests,
  updateSupervisorRuntime,
} from "../src/supervisor-state";
import {
  buildSupervisorStatus,
  type LoopSnapshot,
  computeSupervisorStats,
  noteHeuristicMiss,
  pairOnResolved,
  proposalView,
  revealProposal,
  STATUS_FIELDS,
  SUGGESTED_BAR,
} from "../src/supervisor-status";

// ADR-0127 milestone 4 — shadow proposals are paired with whoever actually
// answered, blind unless the user revealed them first; the agreement numbers
// come from those pairings; and GET /api/supervisor's `status` is the brief's
// §10.1 object, with health and the budget level derived by rule here.

let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const token = () => currentSupervisorToken() as string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m4s-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  applySupervisorAction({ projectId: "proj", action: "start", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] }, token());
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

function propose(toolUseId: string, answer: string[], extra: Partial<LedgerEntryInput> = {}) {
  return appendLedgerEntry("proj", {
    kind: "verb",
    verb: "answer",
    tab: "tab-1",
    wakeId: "w",
    mode: "shadow",
    decision: "propose",
    reason: "grounded",
    grounds: [{ kind: "charter", ref: "Postgres", provenance: "strong" }],
    turnId: "turn-1",
    toolUseId,
    answer,
    ...extra,
  });
}
const resolved = (toolUseId: string, answerValues: string[], answeredBy: "user" | "supervisor" = "user", decision: "allow" | "deny" = "allow") =>
  ({ projectId: "proj", marvinSessionId: "tab-1", turnId: "turn-1", toolUseId, decision, answeredBy, answerValues });

describe("pairing", () => {
  it("pairs a proposal with the user's answer — agree, blind", () => {
    const p = propose("tu-1", ["Postgres"]);
    const line = pairOnResolved("proj", resolved("tu-1", ["Postgres"]));
    expect(line?.kind).toBe("pairing");
    expect(line?.proposalId).toBe(p.id);
    expect(line?.pairing).toEqual({ actualAnswer: ["Postgres"], answeredBy: "user", agreement: "agree", proposalSeenBeforeAnswer: false });
  });

  it("a different answer is a disagreement; a deny is a disagreement with any answer", () => {
    propose("tu-1", ["Postgres"]);
    expect(pairOnResolved("proj", resolved("tu-1", ["SQLite"]))?.pairing?.agreement).toBe("disagree");
    propose("tu-2", ["Postgres"]);
    expect(pairOnResolved("proj", resolved("tu-2", [], "user", "deny"))?.pairing?.agreement).toBe("disagree");
  });

  it("records that the user revealed the proposal before answering", () => {
    const p = propose("tu-1", ["Postgres"]);
    expect(revealProposal("proj", p.id as string).ok).toBe(true);
    expect(pairOnResolved("proj", resolved("tu-1", ["Postgres"]))?.pairing?.proposalSeenBeforeAnswer).toBe(true);
  });

  it("pairs once; nothing to pair when no proposal, or when nobody answered (a timeout)", () => {
    propose("tu-1", ["Postgres"]);
    expect(pairOnResolved("proj", resolved("tu-1", ["Postgres"]))).not.toBeNull();
    expect(pairOnResolved("proj", resolved("tu-1", ["Postgres"]))).toBeNull();
    expect(pairOnResolved("proj", resolved("tu-none", ["x"]))).toBeNull();
    propose("tu-3", ["Postgres"]);
    expect(pairOnResolved("proj", { ...resolved("tu-3", []), answeredBy: undefined })).toBeNull();
  });

  it("a confirm proposal pairs on the decision", () => {
    appendLedgerEntry("proj", { kind: "verb", verb: "confirm", tab: "tab-1", wakeId: "w", mode: "shadow", decision: "propose", reason: "grounded", turnId: "turn-1", toolUseId: "tu-c", answer: ["allow"] });
    expect(pairOnResolved("proj", resolved("tu-c", [], "user", "allow"))?.pairing?.agreement).toBe("agree");
  });
});

describe("reveal and the watch row's proposal", () => {
  it("stays hidden until revealed: no answer, no grounds, but the ledger id to reveal it by", () => {
    const p = propose("tu-1", ["Postgres"]);
    const blind = proposalView(readLedger("proj"), "tu-1");
    expect(blind.proposalRevealed).toBe(false);
    expect(blind.supervisorProposal).toEqual({ ledgerId: p.id, actionId: "answer", grounds: [] });
    revealProposal("proj", p.id as string);
    const seen = proposalView(readLedger("proj"), "tu-1");
    expect(seen.proposalRevealed).toBe(true);
    expect(seen.supervisorProposal).toMatchObject({ ledgerId: p.id, answer: ["Postgres"], grounds: [{ kind: "charter", ref: "Postgres", provenance: "strong" }] });
  });

  it("no proposal reads null; an escalation is not a proposal", () => {
    propose("tu-e", [], { decision: "escalate" });
    expect(proposalView(readLedger("proj"), "tu-e")).toEqual({ supervisorProposal: null, proposalRevealed: false });
  });

  it("reveal refuses an unknown line, a non-proposal, and a proposal already answered; a second reveal is a no-op", () => {
    expect(revealProposal("proj", "nope").ok).toBe(false);
    const esc = propose("tu-e", [], { decision: "escalate" });
    expect(revealProposal("proj", esc.id as string).ok).toBe(false);
    const p = propose("tu-1", ["Postgres"]);
    expect(revealProposal("proj", p.id as string).ok).toBe(true);
    expect(revealProposal("proj", p.id as string).ok).toBe(true);
    expect(readLedger("proj").filter((e) => e.kind === "reveal")).toHaveLength(1);
    const q = propose("tu-2", ["Postgres"]);
    pairOnResolved("proj", resolved("tu-2", ["Postgres"]));
    const late = revealProposal("proj", q.id as string);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.status).toBe(409);
  });
});

describe("stats", () => {
  it("agreement per category from a fixture ledger; answers through /api/confirm count as the user's", () => {
    const a = propose("tu-1", ["Postgres"]);
    revealProposal("proj", a.id as string);
    pairOnResolved("proj", resolved("tu-1", ["Postgres"])); // agree, seen
    propose("tu-2", ["Postgres"]);
    pairOnResolved("proj", resolved("tu-2", ["Postgres"])); // agree, blind
    propose("tu-3", ["Postgres"]);
    pairOnResolved("proj", resolved("tu-3", ["SQLite"])); // disagree
    propose("tu-4", ["Postgres"]); // pending
    propose("tu-5", ["SQLite"], { decision: "act", mode: "autonomous" });
    pairOnResolved("proj", resolved("tu-5", ["SQLite"], "supervisor")); // its own act: not agreement
    propose("tu-6", [], { decision: "escalate", heuristic: "push" });
    appendLedgerEntry("proj", { kind: "verb", verb: "send", tab: "tab-1", wakeId: "w", mode: "shadow", decision: "propose", reason: "grounded" });
    appendLedgerEntry("proj", { kind: "verb", verb: "set_posture", tab: "tab-1", wakeId: "w", mode: "shadow", decision: "escalate", reason: "widening", reasonCode: "widening" });

    const s = computeSupervisorStats(readLedger("proj"));
    expect(s.questions).toEqual({ proposals: 4, agreed: 2, agreedBlind: 1, agreementRate: 2 / 3, humanOnlyProposedAsAct: 1, heuristicMisses: 0 });
    expect(s.nudges.proposals).toBe(1);
    expect(s.nudges.agreementRate).toBeNull();
    expect(s.posture.humanOnlyProposedAsAct).toBe(1);
    expect(s.confirms.proposals).toBe(0);
  });

  it("a question the heuristic passed that led to a human-only confirm in the same turn is a miss, counted once", () => {
    propose("tu-1", ["Postgres"]);
    expect(noteHeuristicMiss("proj", { marvinSessionId: "tab-1", turnId: "turn-1", rule: "metered-ci" })).toBe(true);
    expect(noteHeuristicMiss("proj", { marvinSessionId: "tab-1", turnId: "turn-1", rule: "metered-ci" })).toBe(false);
    expect(noteHeuristicMiss("proj", { marvinSessionId: "tab-1", turnId: "turn-other", rule: "metered-ci" })).toBe(false);
    expect(computeSupervisorStats(readLedger("proj")).questions.heuristicMisses).toBe(1);
  });
});

describe("the status projection — brief §10.1", () => {
  const MODEL = { role: "supervisor" as const, resolved: "claude-sonnet-5-5", label: "Sonnet 5.5", choice: null };
  const idleLoop: LoopSnapshot = { currentWake: null, queuedEvents: 0, oldestQueuedAt: null };
  const status = (loop = idleLoop, now = Date.now()) =>
    buildSupervisorStatus(getSupervisorState("proj"), loop, readLedger("proj"), MODEL, now) as unknown as Record<string, unknown>;

  it("idle: every §10.1 field is present", () => {
    const s = status();
    for (const f of STATUS_FIELDS) expect(s, f).toHaveProperty(f);
    expect(s.run).toBe("idle");
    expect(s.health).toBe("ok");
    expect(s.mode).toBe("shadow");
    expect(s.watchedTabs).toBe(1);
    expect(s.openEscalations).toBe(0);
    expect(s.suggestedBar).toEqual(SUGGESTED_BAR);
    expect(s.confirmsEligible).toBe(false);
    expect(s.revision).toBe(getSupervisorState("proj").revision);
    expect((s.budget as Record<string, unknown>).level).toBe("ok");
    expect(s.caps).toEqual({ maxActionsPerWake: 5, maxTurnsPerWake: 12, perTabRate: 6, globalRate: 20 });
    expect(s.model).toEqual(MODEL);
    expect(Object.keys(s.autonomy as object).sort()).toEqual(["confirms", "nudges", "posture", "questions"]);
  });

  it("waking: run reads waking with the current wake", () => {
    const s = status({ currentWake: { wakeId: "w1", startedAt: new Date().toISOString(), itemCount: 3 }, queuedEvents: 1, oldestQueuedAt: Date.now() });
    expect(s.run).toBe("waking");
    expect(s.currentWake).toMatchObject({ wakeId: "w1", itemCount: 3 });
    expect(s.queuedEvents).toBe(1);
    expect(s.health).toBe("ok");
  });

  it("paused by budget: run paused, the pause record, and budget level reached; 80 % reads near", () => {
    applySupervisorAction({ projectId: "proj", action: "cap", capUsd: 10 }, token());
    noteSupervisorTabSpend("proj", 8.5);
    expect((status().budget as Record<string, unknown>).level).toBe("near");
    noteSupervisorTabSpend("proj", 2);
    const s = status();
    expect(s.run).toBe("paused");
    expect((s.pause as Record<string, unknown>).reason).toBe("budget");
    expect(s.budget).toMatchObject({ capUsd: 10, spentUsd: 10.5, spentTabsUsd: 10.5, spentOwnUsd: 0, level: "reached" });
    expect(typeof (s.budget as Record<string, unknown>).resetsAt).toBe("string");
  });

  it("stale: events queued past the threshold with no wake running", () => {
    const now = Date.now();
    const s = status({ currentWake: null, queuedEvents: 5, oldestQueuedAt: now - 10 * 60_000 }, now);
    expect(s.health).toBe("stale");
    expect(typeof s.healthSince).toBe("string");
  });

  it("failed: the last wake errored", () => {
    updateSupervisorRuntime("proj", { lastWake: { wakeId: "w9", at: new Date().toISOString(), outcome: "failed", error: { message: "boom", detail: "stack" } } });
    const s = status();
    expect(s.health).toBe("failed");
    expect(s.lastWake).toMatchObject({ wakeId: "w9", outcome: "failed" });
  });
});

describe("the ledger read cache", () => {
  it("a read after an append sees the new line, and callers get their own array", () => {
    propose("tu-1", ["Postgres"]);
    const first = readLedger("proj");
    first.length = 0; // a caller mutating its array must not empty the cache
    expect(readLedger("proj").filter((e) => e.verb === "answer")).toHaveLength(1);
    propose("tu-2", ["SQLite"]);
    expect(readLedger("proj").filter((e) => e.verb === "answer")).toHaveLength(2);
    expect(readLedger("proj", { tab: "tab-1", limit: 1 })[0]?.toolUseId).toBe("tu-2");
  });
});
