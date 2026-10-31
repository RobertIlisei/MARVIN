/**
 * What the supervisor has been doing, read back (ADR-0127 milestone 4).
 *
 * - **Shadow pairing.** Each `answer` / `confirm` proposal is paired with
 *   whoever actually answered, when the `confirm.resolved` event says who
 *   (`pairOnResolved`). A pairing is a new ledger line naming the proposal —
 *   the ledger stays append-only.
 * - **Blind until revealed** (design brief, open decision 1). A watch row
 *   carries only a proposal's ledger id until the user reveals it; the reveal
 *   is a ledger line, and the pairing records whether it came first, so the
 *   agreement number can be read with and without anchoring.
 * - **Stats** per category, from those lines alone.
 * - **The status projection** — the brief's §10.1 object. `health` and
 *   `budget.level` are derived here, by rule, so the app holds no policy.
 */

import { type ConfirmRule } from "./confirm-registry";
import { listModelsCached } from "./models";
import { resolveRoleModel } from "./role-models";
import { HUMAN_ONLY_CONFIRM_RULES } from "./supervisor-acts";
import { appendLedgerEntry, type LedgerEntry, type LedgerGround, readLedger } from "./supervisor-ledger";
import { AUTONOMY_CATEGORIES, type AutonomyCategory, overBudget, type SupervisorState } from "./supervisor-state";

/** The bar the brief suggests before switching a category to autonomous. A suggestion, never a gate. */
export const SUGGESTED_BAR = { minProposals: 20, minAgreement: 0.9 } as const;

/** Events queued this long with no wake running read as `stale`. */
export const STALE_AFTER_MS = 5 * 60_000;

const PAIRED_VERBS = new Set(["answer", "confirm"]);
const VERB_CATEGORY: Record<string, AutonomyCategory> = {
  answer: "questions",
  send: "nudges",
  cancel: "nudges",
  set_posture: "posture",
  confirm: "confirms",
};

const isProposal = (e: LedgerEntry) => e.kind === "verb" && !!e.id && PAIRED_VERBS.has(e.verb) && (e.decision === "propose" || e.decision === "act");

function sameAnswer(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((v, i) => v.trim() === (b[i] ?? "").trim());
}

/**
 * Pair the newest unpaired proposal for this question or confirm with the
 * answer that resolved it. Null when there is nothing to pair: no proposal,
 * already paired, or nobody answered (a timeout or a turn unwinding).
 */
export function pairOnResolved(
  projectId: string,
  d: { marvinSessionId: string; toolUseId: string; decision: "allow" | "deny"; answeredBy?: "user" | "supervisor" | undefined; answerValues?: string[] | undefined },
): LedgerEntry | null {
  if (!d.answeredBy) return null;
  const entries = readLedger(projectId, { tab: d.marvinSessionId });
  const proposal = [...entries].reverse().find((e) => isProposal(e) && e.toolUseId === d.toolUseId);
  if (!proposal?.id) return null;
  if (entries.some((e) => e.kind === "pairing" && e.proposalId === proposal.id)) return null;
  const actual = proposal.verb === "confirm" ? [d.decision] : d.decision === "deny" ? [] : (d.answerValues ?? []);
  const agreement = d.decision === "deny" && proposal.verb === "answer" ? "disagree" : sameAnswer(proposal.answer, actual) ? "agree" : "disagree";
  const seen = entries.some((e) => e.kind === "reveal" && e.proposalId === proposal.id);
  return appendLedgerEntry(projectId, {
    kind: "pairing",
    verb: proposal.verb,
    tab: d.marvinSessionId,
    wakeId: proposal.wakeId,
    reason: `answered by the ${d.answeredBy}: ${agreement === "agree" ? "agreed with" : "differed from"} the proposal`,
    proposalId: proposal.id,
    toolUseId: d.toolUseId,
    pairing: { actualAnswer: actual.map((v) => v.slice(0, 200)).slice(0, 20), answeredBy: d.answeredBy, agreement, proposalSeenBeforeAnswer: seen },
  });
}

export type RevealResult = { ok: true } | { ok: false; status: 404 | 409; error: string };

/** `POST /api/supervisor/reveal` — the user looked at a shadow proposal. Idempotent. */
export function revealProposal(projectId: string, ledgerId: string): RevealResult {
  const entries = readLedger(projectId);
  const p = entries.find((e) => e.id === ledgerId);
  if (!p || p.kind !== "verb" || !PAIRED_VERBS.has(p.verb) || p.decision !== "propose") {
    return { ok: false, status: 404, error: "no shadow proposal with that ledger id" };
  }
  if (entries.some((e) => e.kind === "pairing" && e.proposalId === ledgerId)) {
    return { ok: false, status: 409, error: "already answered — a reveal now would not be a reveal before the answer" };
  }
  if (entries.some((e) => e.kind === "reveal" && e.proposalId === ledgerId)) return { ok: true };
  appendLedgerEntry(projectId, {
    kind: "reveal",
    verb: "reveal",
    tab: p.tab,
    wakeId: null,
    reason: "the user revealed the proposal before answering",
    proposalId: ledgerId,
    ...(p.toolUseId ? { toolUseId: p.toolUseId } : {}),
  });
  return { ok: true };
}

export interface ProposalView {
  supervisorProposal: { ledgerId: string; actionId: string; answer?: string[]; grounds: LedgerGround[] } | null;
  proposalRevealed: boolean;
}

/** A watch row's pending confirm: the open shadow proposal for it, blind until revealed (brief §10.3). */
export function proposalView(entries: readonly LedgerEntry[], toolUseId: string): ProposalView {
  const p = [...entries].reverse().find((e) => e.kind === "verb" && e.decision === "propose" && PAIRED_VERBS.has(e.verb) && e.toolUseId === toolUseId && !!e.id);
  if (!p?.id || entries.some((e) => e.kind === "pairing" && e.proposalId === p.id)) return { supervisorProposal: null, proposalRevealed: false };
  const revealed = entries.some((e) => e.kind === "reveal" && e.proposalId === p.id);
  const actionId = p.verb === "confirm" ? (p.answer?.[0] ?? "allow") : "answer";
  return {
    supervisorProposal: revealed
      ? { ledgerId: p.id, actionId, ...(p.answer ? { answer: p.answer } : {}), grounds: p.grounds ?? [] }
      : { ledgerId: p.id, actionId, grounds: [] },
    proposalRevealed: revealed,
  };
}

/** The newest act per tab — the watch row's `supervisor.lastActAt`. */
export function lastActAtByTab(entries: readonly LedgerEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) if (e.kind === "verb" && e.decision === "act" && e.tab) out.set(e.tab, e.at);
  return out;
}

/**
 * A question the heuristic let through, in a turn that then raised a
 * human-only confirm: the answer led toward a §4 act the heuristic did not
 * name. Ledgered once per proposal; true when this call recorded one.
 */
export function noteHeuristicMiss(projectId: string, d: { marvinSessionId: string; turnId: string; rule: ConfirmRule }): boolean {
  if (!HUMAN_ONLY_CONFIRM_RULES.has(d.rule)) return false;
  const entries = readLedger(projectId, { tab: d.marvinSessionId });
  const answered = entries.filter((e) => e.kind === "verb" && e.verb === "answer" && e.turnId === d.turnId && !e.heuristic && (e.decision === "propose" || e.decision === "act") && e.id);
  const fresh = answered.filter((a) => !entries.some((e) => e.kind === "heuristic-miss" && e.proposalId === a.id));
  if (!fresh.length) return false;
  for (const a of fresh) {
    appendLedgerEntry(projectId, {
      kind: "heuristic-miss",
      verb: "answer",
      tab: d.marvinSessionId,
      wakeId: a.wakeId,
      reason: `the turn raised a ${d.rule} confirm after a question the heuristic passed`,
      proposalId: a.id as string,
      turnId: d.turnId,
    });
  }
  return true;
}

export interface CategoryStats {
  proposals: number;
  agreed: number;
  agreedBlind: number;
  agreementRate: number | null;
  humanOnlyProposedAsAct: number;
  heuristicMisses: number;
}

export type SupervisorStats = Record<AutonomyCategory, CategoryStats>;

/**
 * Per category, from the ledger alone. `agreementRate` counts only pairings
 * with the USER's answer (an answer through `/api/confirm` or the sheet); the
 * supervisor agreeing with its own act is not evidence. `humanOnlyProposedAsAct`
 * counts the times the supervisor tried to act and the policy had to stop a
 * human-only act: a heuristic hit on an answer, a §4 confirm, a widening.
 */
export function computeSupervisorStats(entries: readonly LedgerEntry[]): SupervisorStats {
  const zero = (): CategoryStats => ({ proposals: 0, agreed: 0, agreedBlind: 0, agreementRate: null, humanOnlyProposedAsAct: 0, heuristicMisses: 0 });
  const out = Object.fromEntries(AUTONOMY_CATEGORIES.map((c) => [c, zero()])) as SupervisorStats;
  const paired = Object.fromEntries(AUTONOMY_CATEGORIES.map((c) => [c, 0])) as Record<AutonomyCategory, number>;
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id as string, e]));
  for (const e of entries) {
    const cat = VERB_CATEGORY[e.verb];
    if (!cat) continue;
    const s = out[cat];
    if (e.kind === "verb") {
      if (e.decision === "propose") s.proposals += 1;
      // A widening refused at perform time (the posture moved under the proposal) counts too.
      if ((e.decision === "escalate" && (e.heuristic || e.reasonCode === "human-only")) || e.reasonCode === "widening") s.humanOnlyProposedAsAct += 1;
    } else if (e.kind === "pairing" && e.pairing?.answeredBy === "user") {
      const proposal = e.proposalId ? byId.get(e.proposalId) : undefined;
      if (proposal?.decision !== "propose") continue;
      paired[cat] += 1;
      if (e.pairing.agreement === "agree") {
        s.agreed += 1;
        if (!e.pairing.proposalSeenBeforeAnswer) s.agreedBlind += 1;
      }
    } else if (e.kind === "heuristic-miss") {
      s.heuristicMisses += 1;
    }
  }
  for (const c of AUTONOMY_CATEGORIES) out[c].agreementRate = paired[c] ? out[c].agreed / paired[c] : null;
  return out;
}

// ── The status projection (brief §10.1) ─────────────────────────────────────

export interface LoopSnapshot {
  currentWake: { wakeId: string; startedAt: string; itemCount: number } | null;
  queuedEvents: number;
  /** Epoch ms of the oldest queued event, or null. */
  oldestQueuedAt: number | null;
}

export interface SupervisorModelInfo {
  role: "supervisor";
  resolved: string | null;
  label: string | null;
}

/** Every field the brief's §10.1 table names; a route test reads each one. */
export const STATUS_FIELDS = [
  "projectId",
  "revision",
  "mode",
  "autonomy",
  "run",
  "pause",
  "currentWake",
  "queuedEvents",
  "lastWake",
  "health",
  "healthSince",
  "watchedTabs",
  "openEscalations",
  "budget",
  "charter",
  "model",
  "stats",
  "suggestedBar",
  "confirmsEligible",
  "caps",
] as const;

function nextUtcMidnight(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)).toISOString();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export function buildSupervisorStatus(
  st: SupervisorState,
  loop: LoopSnapshot,
  entries: readonly LedgerEntry[],
  model: SupervisorModelInfo,
  now: number = Date.now(),
  /** Milestone 5 — open inbox items (`openEscalationCounts`). */
  openEscalations = 0,
) {
  const today = new Date(now).toISOString().slice(0, 10);
  const current = st.spend.day === today;
  const spentUsd = current ? st.spend.usd : 0;
  const cap = st.caps.dailyBudgetUsd;
  const level = current && overBudget(st) ? "reached" : spentUsd >= cap * 0.8 ? "near" : "ok";

  let health: "ok" | "stale" | "failed" = "ok";
  let healthSince = st.lastWake?.at ?? st.updatedAt;
  if (st.lastWake?.outcome === "failed") {
    health = "failed";
    healthSince = st.lastWake.at;
  } else if (st.mode !== "off" && !st.paused && !loop.currentWake && loop.queuedEvents > 0 && loop.oldestQueuedAt !== null && now - loop.oldestQueuedAt > STALE_AFTER_MS) {
    health = "stale";
    healthSince = new Date(loop.oldestQueuedAt + STALE_AFTER_MS).toISOString();
  }

  const delegations = Object.values(st.delegation);
  return {
    projectId: st.projectId,
    revision: st.revision,
    mode: st.mode,
    autonomy: { ...st.autonomy },
    run: st.paused ? ("paused" as const) : loop.currentWake ? ("waking" as const) : ("idle" as const),
    pause: st.pause,
    currentWake: loop.currentWake,
    queuedEvents: loop.queuedEvents,
    lastWake: st.lastWake,
    health,
    healthSince,
    watchedTabs: delegations.filter((d) => d !== "off").length,
    openEscalations,
    budget: {
      capUsd: cap,
      spentUsd,
      spentOwnUsd: current ? st.spend.ownUsd : 0,
      spentTabsUsd: current ? st.spend.tabsUsd : 0,
      // ADR-0128 §7 — the supervisor's own spend, split; one cap still stops everything.
      spentConversationUsd: current ? st.spend.conversationUsd : 0,
      spentWatchingUsd: current ? Math.max(0, st.spend.ownUsd - st.spend.conversationUsd) : 0,
      resetsAt: nextUtcMidnight(today),
      level,
    },
    charter: { text: st.charter, updatedAt: st.charterUpdatedAt },
    model,
    stats: computeSupervisorStats(entries),
    suggestedBar: { ...SUGGESTED_BAR },
    confirmsEligible: delegations.includes("answer-confirms"),
    caps: {
      maxActionsPerWake: st.caps.maxActionsPerWake,
      maxTurnsPerWake: st.caps.maxTurnsPerWake,
      perTabRate: st.caps.perTabActsPer10Min,
      globalRate: st.caps.globalActsPer10Min,
    },
  };
}

export type SupervisorStatus = ReturnType<typeof buildSupervisorStatus>;

/** The supervisor role's model as the expanded block shows it. Never throws: an unreachable catalogue reads as unresolved. */
export async function supervisorModelInfo(): Promise<SupervisorModelInfo> {
  try {
    const resolved = await resolveRoleModel("supervisor");
    if (!resolved || resolved === "inherit") return { role: "supervisor", resolved: null, label: null };
    const known = (await listModelsCached()).models.find((m) => m.id === resolved);
    return { role: "supervisor", resolved, label: known?.displayName ?? resolved };
  } catch {
    return { role: "supervisor", resolved: null, label: null };
  }
}
