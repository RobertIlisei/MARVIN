/**
 * The supervisor's policy (ADR-0127 §3, §4, §6) — deterministic checks every
 * act verb passes before anything is proposed, performed or escalated.
 *
 * - **Grounds carry provenance.** A citation must resolve, and it is *strong*
 *   only when the tab did not write it: the user's charter, the user's own
 *   brief, a plan seeded from that brief, an artifact on the main checkout
 *   that predates the tab. Anything the tab authored is *weak*. An act needs
 *   one strong ground or it escalates — a claim does not check itself
 *   (ADR-0116).
 * - **The question heuristic is a heuristic.** A keyword list over a
 *   question's text and options; wording evades it, so its hits are ledgered
 *   and its misses are measured in shadow. The line that holds regardless is
 *   the consent gate on supervisor-touched turns (milestone 3).
 * - **Stopping conditions in code**: duplicate drop, per-tab and project rate
 *   limits, and the per-wake breaker.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { classifyPostureChange, type ModelLookup, type PosturePatch } from "./posture";
import type { SessionPosture } from "./session-meta";
import type { GroundKind, LedgerDecision, LedgerGround } from "./supervisor-ledger";
import type { ConfirmRule } from "./confirm-registry";
import { HUMAN_ONLY_CONFIRM_RULES, type HumanOnlyAct } from "./supervisor-acts";
import { type Delegation, delegationRank, type SupervisorCaps, type SupervisorMode } from "./supervisor-state";

export interface GroundRef {
  kind: GroundKind;
  ref: string;
}

/** What a citation is resolved against, assembled per tab by the runtime. */
export interface GroundContext {
  /** The project root — the main checkout. */
  mainRoot: string;
  /** The tab's worktree, or null for a shared tab. */
  tabRoot: string | null;
  /** The user's charter (data dir; user-set). */
  charter: string;
  /** The tab's first user message — the user's own words. */
  brief: string | null;
  /** Top-level steps in the tab's active plan. */
  planStepCount: number;
  /** The plan was seeded from the user's brief (ADR-0124), not presented by the tab. */
  planSeeded: boolean;
  /** When the tab started; a memory fact written after it is the tab's own. */
  tabStartedAt: number | null;
}

const ADR_DIRS = ["docs/decisions", "docs/adr", "docs/adrs"];
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/i;

function adrExists(root: string, num: string): boolean {
  for (const d of ADR_DIRS) {
    const dir = path.join(root, d);
    if (!existsSync(dir)) continue;
    try {
      if (readdirSync(dir).some((f) => f.startsWith(`${num}-`) && f.endsWith(".md"))) return true;
    } catch {
      /* unreadable dir — keep looking */
    }
  }
  return false;
}

/** A path inside `root`, or null when it would escape it. */
function inside(root: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(`${r}${path.sep}`) ? abs : null;
}

export function resolveGround(g: GroundRef, ctx: GroundContext): LedgerGround & { why?: string } {
  const out = (provenance: LedgerGround["provenance"], why?: string) => ({
    kind: g.kind,
    ref: g.ref,
    provenance,
    ...(why ? { why } : {}),
  });
  const ref = typeof g.ref === "string" ? g.ref.trim() : "";
  if (!ref) return out("unresolved", "empty reference");

  switch (g.kind) {
    case "adr": {
      const m = /^(?:ADR-)?(\d{1,4})$/i.exec(ref);
      if (!m?.[1]) return out("unresolved", "not an ADR number");
      const num = m[1].padStart(4, "0");
      if (adrExists(ctx.mainRoot, num)) return out("strong");
      if (ctx.tabRoot && adrExists(ctx.tabRoot, num)) return out("weak", "exists only in the tab's tree");
      return out("unresolved", `ADR-${num} does not exist`);
    }
    case "charter":
      return ctx.charter?.includes(ref) ? out("strong") : out("unresolved", "not a quote from the charter");
    case "dod":
      return ctx.brief?.includes(ref) ? out("strong") : out("unresolved", "not in the user's brief");
    case "plan": {
      const m = /^(\d+)(?:\.\d+)?$/.exec(ref);
      const n = m?.[1] ? Number(m[1]) : 0;
      if (!n || n > ctx.planStepCount) return out("unresolved", `no step ${ref} in the active plan`);
      return ctx.planSeeded ? out("strong") : out("weak", "the plan was presented by the tab, not seeded from the brief");
    }
    case "memory": {
      if (!SLUG_RE.test(ref) || ref.includes("..")) return out("unresolved", "not a memory slug");
      const file = path.join(ctx.mainRoot, ".marvin", "memory", `${ref}.md`);
      if (!existsSync(file)) return out("unresolved", `no memory fact ${ref}`);
      const mtime = statSync(file).mtimeMs;
      if (ctx.tabStartedAt !== null && mtime >= ctx.tabStartedAt) return out("weak", "written after the tab started");
      return out("strong");
    }
    case "file": {
      const m = /^(main|tab):(.+?)(?::(\d+))?$/.exec(ref);
      if (!m?.[1] || !m[2]) return out("unresolved", "expected main:<path>[:line] or tab:<path>[:line]");
      const root = m[1] === "main" ? ctx.mainRoot : ctx.tabRoot;
      if (!root) return out("unresolved", "this tab has no tree of its own");
      const abs = inside(root, m[2]);
      if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return out("unresolved", `no file ${m[2]}`);
      if (m[3]) {
        const lines = readFileSync(abs, "utf8").split("\n").length;
        if (Number(m[3]) < 1 || Number(m[3]) > lines) return out("unresolved", `line ${m[3]} is past the end of ${m[2]}`);
      }
      return m[1] === "main" ? out("strong") : out("weak", "the tab's own tree");
    }
    default:
      return out("unresolved", "unknown ground kind");
  }
}

// ── The question heuristic (ADR-0127 §4) ─────────────────────────────────────

/** Terms naming a human-only act. Ordered most specific first; the first match is reported. */
export const QUESTION_HEURISTIC_TERMS: ReadonlyArray<readonly [string, RegExp]> = [
  ["approve the plan", /\bapprove (the |this )?plan\b/i],
  ["merge request", /\bmerge requests?\b|\bMR\b/],
  ["pull request", /\bpull requests?\b|\bPR\b/],
  ["force", /\bforce[- ]push\b|--force\b/i],
  ["push", /\bpush(es|ed|ing)?\b/i],
  ["merge", /\bmerg(e|es|ed|ing)\b/i],
  ["rebase", /\brebas(e|ed|ing)\b/i],
  ["deploy", /\bdeploy(s|ed|ing|ment)?\b/i],
  ["release", /\brelease\b/i],
  ["publish", /\bpublish(es|ed|ing)?\b/i],
  ["migration", /\bmigrat(e|es|ed|ing|ion|ions)\b/i],
  [".env", /(^|[\s/`'"])\.env\b/i],
  ["credentials", /\bcredentials?\b|\bsecrets?\b|\bpasswords?\b|\bapi[ -]?keys?\b|\btokens?\b/i],
  ["delete", /\bdelet(e|es|ed|ing)\b|\bdiscard\b|\bdrop (the )?(table|branch|database|worktree)\b|\breset --hard\b/i],
  ["production", /\bproduction\b|\bprod\b/i],
  ["ci", /\bpipeline\b|\bCI\b/],
];

/** The first human-only term any of the texts names, or null. */
export function questionHeuristic(texts: readonly string[]): string | null {
  for (const [term, re] of QUESTION_HEURISTIC_TERMS) {
    if (texts.some((t) => re.test(t))) return term;
  }
  return null;
}

// ── The answer verb's decision ───────────────────────────────────────────────

export interface AnswerEvaluationInput {
  mode: SupervisorMode;
  delegation: Delegation | undefined;
  targetIsSupervisor: boolean;
  /** Question text, option labels and descriptions — what the heuristic reads. */
  questionTexts: string[];
  grounds: GroundRef[];
  groundCtx: GroundContext;
  /** The supervisor chose to escalate rather than answer. */
  escalate?: { reason: string } | undefined;
}

export interface PolicyOutcome {
  decision: LedgerDecision;
  reason: string;
  grounds: LedgerGround[];
  heuristic?: string;
  /** A stable code for the reason (ledger `reasonCode`, brief §10.5). Set by the milestone 3 evaluators. */
  reasonCode?: string;
}

export function evaluateAnswer(input: AnswerEvaluationInput): PolicyOutcome {
  const grounds = input.grounds.map((g) => resolveGround(g, input.groundCtx));
  const plain = grounds.map(({ kind, ref, provenance }) => ({ kind, ref, provenance }));
  const done = (decision: LedgerDecision, reason: string, extra: Partial<PolicyOutcome> = {}): PolicyOutcome => ({
    decision,
    reason,
    grounds: plain,
    ...extra,
  });

  if (input.targetIsSupervisor) return done("refuse", "a supervisor session is never a target (no recursion)");
  if (input.mode === "off") return done("refuse", "the supervisor is off");
  const rank = delegationRank(input.delegation);
  if (input.escalate) {
    return rank >= delegationRank("observe")
      ? done("escalate", `supervisor escalated: ${input.escalate.reason}`)
      : done("refuse", "this tab is not delegated to the supervisor");
  }
  if (rank < delegationRank("answer-questions")) {
    return done("refuse", `delegation "${input.delegation ?? "off"}" does not allow answering questions`);
  }
  const heuristic = questionHeuristic(input.questionTexts);
  if (heuristic) {
    return done("escalate", `the question names a human-only act ("${heuristic}", heuristic)`, { heuristic });
  }
  if (grounds.length === 0) return done("refuse", "no grounds cited — every answer cites what it rests on");
  const bad = grounds.filter((g) => g.provenance === "unresolved");
  if (bad.length > 0) {
    return done("refuse", `citation does not resolve: ${bad.map((g) => `${g.kind}:${g.ref} (${g.why ?? "unresolved"})`).join("; ")}`);
  }
  if (!grounds.some((g) => g.provenance === "strong")) {
    return done("escalate", "only weak grounds — every cited artifact was written by the tab itself");
  }
  return input.mode === "autonomous"
    ? done("act", "grounded; the questions category is autonomous")
    : done("propose", "grounded; shadow mode records the proposal and performs nothing");
}

// ── The set_posture verb's decision (milestone 2) ───────────────────────────

/**
 * A supervisor may narrow a tab's posture on its own; any widening is the
 * user's act and escalates (ADR-0127 §4 item 5) — Plan → Agent included, which
 * is how plan approval is expressed. Grounds are required, as for answers.
 */
export function evaluateSetPosture(input: {
  mode: SupervisorMode;
  delegation: Delegation | undefined;
  targetIsSupervisor: boolean;
  from: SessionPosture;
  patch: PosturePatch;
  lookup: ModelLookup;
  grounds: GroundRef[];
  groundCtx: GroundContext;
}): PolicyOutcome {
  const grounds = input.grounds.map((g) => resolveGround(g, input.groundCtx));
  const plain = grounds.map(({ kind, ref, provenance }) => ({ kind, ref, provenance }));
  const done = (decision: LedgerDecision, reason: string): PolicyOutcome => ({ decision, reason, grounds: plain });

  if (input.targetIsSupervisor) return done("refuse", "a supervisor session is never a target (no recursion)");
  if (input.mode === "off") return done("refuse", "the supervisor is off");
  if (delegationRank(input.delegation) < delegationRank("answer-questions")) {
    return done("refuse", `delegation "${input.delegation ?? "off"}" does not allow changing posture`);
  }
  const changes = classifyPostureChange(input.from, input.patch, input.lookup);
  const widening = changes.filter((c) => c.direction === "widen");
  if (widening.length) {
    return done("escalate", `widening is the user's act: ${widening.map((c) => `${c.field} ${c.from ?? "?"} → ${c.to}`).join("; ")}`);
  }
  if (grounds.length === 0) return done("refuse", "no grounds cited — every posture change cites what it rests on");
  const bad = grounds.filter((g) => g.provenance === "unresolved");
  if (bad.length) return done("refuse", `citation does not resolve: ${bad.map((g) => `${g.kind}:${g.ref} (${g.why ?? "unresolved"})`).join("; ")}`);
  if (!grounds.some((g) => g.provenance === "strong")) return done("escalate", "only weak grounds — every cited artifact was written by the tab itself");
  const what = changes.map((c) => `${c.field} ${c.from ?? "?"} → ${c.to}`).join("; ") || "no change";
  return input.mode === "autonomous"
    ? done("act", `narrowing (${what}); the posture category is autonomous`)
    : done("propose", `narrowing (${what}); shadow mode records the proposal and performs nothing`);
}

// ── Milestone 3: send, cancel and confirm ───────────────────────────────────

type Done = (decision: LedgerDecision, reasonCode: string, reason: string) => PolicyOutcome;

function judge(grounds: GroundRef[], groundCtx: GroundContext): { done: Done; resolved: Array<LedgerGround & { why?: string }> } {
  const resolved = grounds.map((g) => resolveGround(g, groundCtx));
  const plain = resolved.map(({ kind, ref, provenance }) => ({ kind, ref, provenance }));
  return { resolved, done: (decision, reasonCode, reason) => ({ decision, reason, reasonCode, grounds: plain }) };
}

/** Grounds every act needs: present, resolvable, at least one the tab did not write. Null when they hold. */
function groundsVerdict(resolved: Array<LedgerGround & { why?: string }>, done: Done, what: string): PolicyOutcome | null {
  if (resolved.length === 0) return done("refuse", "ungrounded", `no grounds cited — every ${what} cites what it rests on`);
  const bad = resolved.filter((g) => g.provenance === "unresolved");
  if (bad.length) return done("refuse", "unresolvable-citation", `citation does not resolve: ${bad.map((g) => `${g.kind}:${g.ref} (${g.why ?? "unresolved"})`).join("; ")}`);
  if (!resolved.some((g) => g.provenance === "strong")) return done("escalate", "weak-grounds-only", "only weak grounds — every cited artifact was written by the tab itself");
  return null;
}

function common(input: { mode: SupervisorMode; targetIsSupervisor: boolean }, done: Done): PolicyOutcome | null {
  if (input.targetIsSupervisor) return done("refuse", "supervisor-session", "a supervisor session is never a target (no recursion)");
  if (input.mode === "off") return done("refuse", "off", "the supervisor is off");
  return null;
}

/** Nudges a tab may get at one plan step with no spine progress; the next one escalates (§6). */
export const NUDGES_PER_PLAN_STEP = 2;

/**
 * `send` — a follow-up or nudge inside the tab's approved plan (ADR-0127 §3,
 * `answer-questions` and up). Refused for a tab the user stopped, one waiting
 * on its own job or wakeup, a busy shared checkout and secret-shaped text; a
 * third nudge at one plan step without spine progress escalates.
 */
export function evaluateSend(input: {
  mode: SupervisorMode;
  delegation: Delegation | undefined;
  targetIsSupervisor: boolean;
  kind: "nudge" | "instruction";
  /** The tab's own state, from the send path's refusal rules. */
  tabRefusal: { code: string; reason: string } | null;
  secret: boolean;
  /** Nudges already proposed or sent at this plan step with no spine progress. */
  priorNudgesAtStep: number;
  grounds: GroundRef[];
  groundCtx: GroundContext;
}): PolicyOutcome {
  const { done, resolved } = judge(input.grounds, input.groundCtx);
  const first = common(input, done);
  if (first) return first;
  if (delegationRank(input.delegation) < delegationRank("answer-questions")) {
    return done("refuse", "delegation", `delegation "${input.delegation ?? "off"}" does not allow messages`);
  }
  if (input.secret) return done("refuse", "secret", "the message carries a secret-shaped string (ADR-0127 §6)");
  if (input.tabRefusal) return done("refuse", input.tabRefusal.code, input.tabRefusal.reason);
  if (input.kind === "nudge" && input.priorNudgesAtStep >= NUDGES_PER_PLAN_STEP) {
    return done("escalate", "nudge-cap", `${input.priorNudgesAtStep} nudges at this plan step without spine progress — the user decides what happens next`);
  }
  const g = groundsVerdict(resolved, done, "message");
  if (g) return g;
  return done("propose", "grounded", "grounded; shadow mode records the proposal and sends nothing");
}

/** `cancel` — stop a runaway turn (`answer-questions` and up). */
export function evaluateCancel(input: {
  mode: SupervisorMode;
  delegation: Delegation | undefined;
  targetIsSupervisor: boolean;
  hasLiveTurn: boolean;
  grounds: GroundRef[];
  groundCtx: GroundContext;
}): PolicyOutcome {
  const { done, resolved } = judge(input.grounds, input.groundCtx);
  const first = common(input, done);
  if (first) return first;
  if (delegationRank(input.delegation) < delegationRank("answer-questions")) {
    return done("refuse", "delegation", `delegation "${input.delegation ?? "off"}" does not allow cancelling a turn`);
  }
  if (!input.hasLiveTurn) return done("refuse", "no-live-turn", "the tab has no turn running");
  const g = groundsVerdict(resolved, done, "cancel");
  if (g) return g;
  return done("propose", "grounded", "grounded; shadow mode records the proposal and cancels nothing");
}

/**
 * `confirm` — allow or deny an ORDINARY permission confirm (`answer-confirms`).
 * A confirm only the user may answer (a supervisor-touched turn) is refused;
 * a containment or money confirm, or one whose act is on the §4 list, is
 * escalated at every level; a question belongs to `answer`.
 */
export function evaluateConfirm(input: {
  mode: SupervisorMode;
  delegation: Delegation | undefined;
  targetIsSupervisor: boolean;
  raisedBy: ConfirmRule | null;
  userOnly: boolean;
  act: HumanOnlyAct | null;
  grounds: GroundRef[];
  groundCtx: GroundContext;
}): PolicyOutcome {
  const { done, resolved } = judge(input.grounds, input.groundCtx);
  const first = common(input, done);
  if (first) return first;
  if (delegationRank(input.delegation) < delegationRank("observe")) return done("refuse", "delegation", "this tab is not delegated to the supervisor");
  if (input.raisedBy === "ask-user-question") return done("refuse", "is-question", "that is a question — use `answer`");
  if (input.userOnly) return done("refuse", "user-only", "only the user can answer this confirm: the supervisor touched this turn (ADR-0127 §5)");
  if (input.raisedBy && HUMAN_ONLY_CONFIRM_RULES.has(input.raisedBy)) {
    return done("escalate", "human-only", `a ${input.raisedBy} confirm is a human-only act (ADR-0127 §4)`);
  }
  if (input.act) return done("escalate", "human-only", `${input.act.label} is a human-only act (ADR-0127 §4, ${input.act.item})`);
  if (delegationRank(input.delegation) < delegationRank("answer-confirms")) {
    return done("refuse", "delegation", `delegation "${input.delegation ?? "off"}" does not allow answering confirms`);
  }
  const g = groundsVerdict(resolved, done, "confirm");
  if (g) return g;
  return done("propose", "grounded", "grounded; shadow mode records the proposal and answers nothing");
}

// ── Stopping conditions (§6) ─────────────────────────────────────────────────

const WINDOW_MS = 10 * 60_000;

export class ActionLimiter {
  private readonly acts = new Map<string, Array<{ at: number; tab: string; key: string }>>();

  constructor(
    private readonly caps: () => SupervisorCaps,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(projectId: string): Array<{ at: number; tab: string; key: string }> {
    const cutoff = this.now() - WINDOW_MS;
    const list = (this.acts.get(projectId) ?? []).filter((a) => a.at > cutoff);
    this.acts.set(projectId, list);
    return list;
  }

  /** `wakeActs` — act verbs already invoked in the current wake. */
  check(projectId: string, tab: string, key: string, wakeActs: number): { ok: true } | { ok: false; reason: string } {
    const caps = this.caps();
    if (wakeActs >= caps.maxActionsPerWake) {
      return { ok: false, reason: `per-wake breaker: ${caps.maxActionsPerWake} acts already this wake` };
    }
    const list = this.recent(projectId);
    if (list.some((a) => a.tab === tab && a.key === key)) {
      return { ok: false, reason: "duplicate: the same act on the same tab inside ten minutes" };
    }
    if (list.filter((a) => a.tab === tab).length >= caps.perTabActsPer10Min) {
      return { ok: false, reason: `rate limit: ${caps.perTabActsPer10Min} acts on this tab in ten minutes` };
    }
    if (list.length >= caps.globalActsPer10Min) {
      return { ok: false, reason: `rate limit: ${caps.globalActsPer10Min} acts across the project in ten minutes` };
    }
    return { ok: true };
  }

  record(projectId: string, tab: string, key: string): void {
    this.recent(projectId).push({ at: this.now(), tab, key });
  }
}
