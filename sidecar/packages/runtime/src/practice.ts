/**
 * The practice loop (ADR-0105): a scheduled, read-only pass over a project's
 * session transcripts that turns repeat failures into findings, findings
 * into proposed rules, and accepted rules into enforcement at one of three
 * tiers — then measures whether they held.
 *
 * Files, all under the MARVIN data dir (this is MARVIN's behaviour, not the
 * project's data — `.marvin/` in the project stays the user's):
 *
 *   practice/config.json            weights, thresholds, schedule
 *   practice/rules.json             rules (scoped to a project or global)
 *   practice/<projectId>/ledger.json findings, watermarks, run records
 *
 * No model is dispatched anywhere in this file. Extractors are deterministic
 * (`practice-extractors.ts`); proposals come from templates; a later phase
 * may let the user ask the session-auditor model to draft a better message
 * from the AGGREGATES the pane shows — never from a transcript, and never
 * from the runner.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { marvinPaths } from "./paths";
import { listSessions } from "./session";
import {
  COST_UNITS,
  EXTRACTOR_VERSION,
  type FingerprintKind,
  kindOf,
  type Occurrence,
  parseSessionTranscript,
  POLARITY,
  SUCCESS_PAIR,
  extractAll,
} from "./practice-extractors";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PracticeWeights {
  recurrence: number;
  cost: number;
  rate: number;
  reliability: number;
  actionability: number;
  decay: number;
}

export interface PracticeConfig {
  /** Nightly runner on/off (per install). */
  enabled: boolean;
  /** Local hour (0–23) the nightly run fires. */
  hour: number;
  weights: PracticeWeights;
  thresholds: { minSessions: number; minValue: number; turnOverbudgetUsd: number };
  /** Per-kind cost that counts as "1.0" in the cost factor. */
  costScale: Record<string, number>;
  /** Sessions after acceptance with no recurrence before a rule is confirmed. */
  verifyWindow: number;
  /** Phase 5 — where the current weights came from, when they were fitted. */
  fit?: { at: string; samples: number; labelled: number; method: string; rho: number } | undefined;
}

export const DEFAULT_PRACTICE_CONFIG: PracticeConfig = {
  enabled: true,
  hour: 3,
  weights: { recurrence: 0.3, cost: 0.2, rate: 0.15, reliability: 0.2, actionability: 0.15, decay: 0.15 },
  thresholds: { minSessions: 3, minValue: 0.6, turnOverbudgetUsd: 10 },
  costScale: {
    "ship.unreviewed": 1,
    "graph.first.skipped": 15,
    "turn.stalled": 1800,
    "scope.met.missing": 1,
    "cache.recreated": 800_000,
    "hook.deny.repeated": 5,
    "error.repeated": 3,
    "skill.bypassed": 3,
    "review.ignored": 1,
    "plan.stale": 1,
    "command.retried": 3,
    "turn.overbudget": 20,
  },
  verifyWindow: 5,
};

/** Reliability of the signal per kind. Every v1 extractor is deterministic. */
export const RELIABILITY: Record<FingerprintKind, number> = {
  "ship.unreviewed": 1,
  "graph.first.skipped": 1,
  "turn.stalled": 1,
  "scope.met.missing": 1,
  "cache.recreated": 1,
  "hook.deny.repeated": 1,
  "error.repeated": 1,
  "ship.reviewed": 1,
  "graph.first.followed": 1,
  "turn.continued": 1,
  "scope.met.present": 1,
  "skill.bypassed": 1,
  "review.ignored": 0.8, // the findings regex is a format match, not a semantic one
  "plan.stale": 1,
  "command.retried": 1,
  "turn.overbudget": 1,
  "skill.invoked": 1,
  "review.acted": 0.8,
  "plan.kept": 1,
  "command.adapted": 1,
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type RuleTier = "prompt" | "nudge" | "deny";
export type RuleStatus = "active" | "retired";

export interface RuleCondition {
  counter: "sourceFilesRead" | "graphCallCount" | "novelFilesSinceGraph" | "editedFiles";
  op: "gte" | "eq" | "lte";
  value: number;
}

export interface RuleTrigger {
  /** Regex on the tool name. */
  tool: string;
  /** Input field to test `pattern` against (stringified). */
  field?: string;
  pattern?: string;
  /** Only when the call is a commit whose diff touches a boundary path. */
  boundaryPaths?: boolean;
  /** The discharge path a `deny` needs: any of these skills run this session. */
  requireSkillThisSession?: string[];
  conditions?: RuleCondition[];
}

export interface PracticeRule {
  id: string;
  /** Phase 3 — a hand-written gate exposed as a row. Its logic stays in
   *  `design-hooks.ts`; the row decides tier, on/off and message. */
  builtin?: boolean;
  fingerprint: string;
  title: string;
  tier: RuleTier;
  /** Null for prompt-tier rules — they have no moment to fire at. */
  trigger: RuleTrigger | null;
  message: string;
  status: RuleStatus;
  scope: { projectId: string | null };
  provenance: { findingId: string; distinctSessions: number; costTotal: number; value: number };
  metrics: { fired: number; lastFiredAt: string | null; bypasses: number };
  createdAt: string;
  acceptedAt: string;
  updatedAt: string;
}

interface RuleTemplate {
  title: string;
  tier: RuleTier;
  trigger: RuleTrigger | null;
  message: string;
}

/** What approving a finding creates. `null` = report-only: the finding is
 *  about MARVIN's implementation or its environment, not a behaviour a rule
 *  can change, so it surfaces in the pane and cannot be approved. */
export const RULE_TEMPLATES: Record<FingerprintKind, RuleTemplate | null> = {
  "ship.unreviewed": {
    title: "Review before a boundary commit",
    tier: "deny",
    trigger: {
      tool: "^Bash$",
      field: "command",
      pattern: "\\bgit\\b[^|;&\\n]*\\bcommit\\b",
      boundaryPaths: true,
      requireSkillThisSession: ["pr-review", "security-audit"],
    },
    message:
      "practice rule: this commit touches a security-boundary path and no review skill has run this session. " +
      'Run `Skill { skill: "security-audit" }` and `Skill { skill: "pr-review" }` first, act on their findings, then commit.',
  },
  "graph.first.skipped": {
    title: "Consult the graph before the fifth source read",
    tier: "nudge",
    trigger: {
      tool: "^(Read|Bash)$",
      conditions: [
        { counter: "sourceFilesRead", op: "gte", value: 5 },
        { counter: "graphCallCount", op: "eq", value: 0 },
      ],
    },
    message:
      "practice rule: five source reads and no graph call this turn. Orient with `graph_search` / `graph_affected` " +
      "before reading further — measured across sessions, this turn shape is the one that drifts.",
  },
  "turn.stalled": {
    title: "Finish the approved plan before ending a turn",
    tier: "prompt",
    trigger: null,
    message:
      "When steps of an approved plan remain and the last one passed its checks, CONTINUE in the same turn. " +
      "Measured across this project's sessions: turns that stopped with no question were answered with a bare " +
      '"continue" — the user waited for nothing.',
  },
  "scope.met.missing": {
    title: "Hand off real work with the scope-met block",
    tier: "prompt",
    trigger: null,
    message:
      "A turn that edited files must end with `**Scope met:** …` and the `<!-- marvin:scope-met -->` sentinel. " +
      "Measured across this project's sessions: real-work turns kept ending without the handoff.",
  },
  "cache.recreated": null,
  "hook.deny.repeated": {
    title: "Stop tripping the same gate",
    tier: "prompt",
    trigger: null,
    message:
      "One of MARVIN's gates denied you repeatedly in past sessions. The deny message names the remedy; " +
      "do the remedy the first time instead of retrying the same call.",
  },
  "error.repeated": null,
  "ship.reviewed": null,
  "graph.first.followed": null,
  "turn.continued": null,
  "scope.met.present": null,
  "skill.bypassed": {
    title: "Invoke a skill instead of reading its files",
    tier: "nudge",
    trigger: { tool: "^Read$", field: "file_path", pattern: "/\\.(claude|marvin)/skills/" },
    message:
      "practice rule: you are reading a skill's files by hand. Invoke it instead — `Skill { skill: \"<name>\" }` " +
      "loads its own instructions. Measured across this project's sessions: the skill was re-derived from its " +
      "folder instead of being used.",
  },
  "review.ignored": {
    title: "Act on a review's findings before moving on",
    tier: "prompt",
    trigger: null,
    message:
      "When `pr-review` or `security-audit` reports findings, address them (edit, or say explicitly why not) in the " +
      "same turn. Measured across this project's sessions: reviews ran, reported findings, and nothing followed.",
  },
  "plan.stale": {
    title: "Keep the plan's checklist moving",
    tier: "prompt",
    trigger: null,
    message:
      "A turn that edits three or more files under an approved plan must update the plan's `TodoWrite` checklist in " +
      "that turn or the next. Measured across this project's sessions: real work happened and the plan never moved.",
  },
  "command.retried": {
    title: "Change something before re-running a failed command",
    tier: "prompt",
    trigger: null,
    message:
      "A command that failed must not be re-run unchanged. Read the error, change the command or the state, then run. " +
      "Measured across this project's sessions: the same failing command was repeated verbatim.",
  },
  "turn.overbudget": null,
  "skill.invoked": null,
  "review.acted": null,
  "plan.kept": null,
  "command.adapted": null,
};

export const TIER_ORDER: RuleTier[] = ["prompt", "nudge", "deny"];

// ---------------------------------------------------------------------------
// Phase 3 — built-in gates as rows
// ---------------------------------------------------------------------------

export const BUILTIN_RULE_IDS = [
  "builtin:graphify-first",
  "builtin:graph-drift-deny",
  "builtin:advisor-on-adr",
  "builtin:ship-review",
] as const;
export type BuiltinRuleId = (typeof BUILTIN_RULE_IDS)[number];

const BUILTIN_SEEDS: Record<BuiltinRuleId, { title: string; fingerprint: string; message: string }> = {
  "builtin:graphify-first": {
    title: "Graph before the first structural read",
    fingerprint: "graph.first.skipped",
    message:
      "The first Read / Grep / Glob / search of a turn is refused until a graph_* call has been made (ADR-0060). " +
      "Native message names the file and a suggested query; edit this text only if you want to replace it.",
  },
  "builtin:graph-drift-deny": {
    title: "Graph drift stop",
    fingerprint: "graph.first.skipped",
    message:
      "After 25 novel source files with no graph call, the next read is refused until the graph is consulted (ADR-0083).",
  },
  "builtin:advisor-on-adr": {
    title: "Advisor before an ADR-trigger edit",
    fingerprint: "hook.deny.repeated:advisor-on-adr-trigger",
    message:
      "An Edit / Write on an auth, credential, migration, schema, CI, container or policy path is refused until an " +
      "advisor consult has run this turn (ADR-0007). Native message names the path and the exact dispatch.",
  },
  "builtin:ship-review": {
    title: "Review before a boundary commit",
    fingerprint: "ship.unreviewed",
    message:
      "A git commit whose diff touches a security boundary is refused until pr-review and security-audit have run " +
      "for the tree; a large diff needs pr-review (ADR-0104). Native message names the files and the Skill calls.",
  },
};

/** Seed the four built-in rows when missing. Called from the pane's read
 *  path only — never from a hook — so a process with no rules file (the
 *  gate tests) keeps native behaviour. */
export function ensureBuiltinRules(): PracticeRule[] {
  const rules = readRules();
  let changed = false;
  const now = new Date().toISOString();
  for (const id of BUILTIN_RULE_IDS) {
    if (rules.some((r) => r.id === id)) continue;
    const seed = BUILTIN_SEEDS[id];
    rules.push({
      id,
      builtin: true,
      fingerprint: seed.fingerprint,
      title: seed.title,
      tier: "deny",
      trigger: null,
      message: seed.message,
      status: "active",
      scope: { projectId: null },
      provenance: { findingId: seed.fingerprint, distinctSessions: 0, costTotal: 0, value: 0 },
      metrics: { fired: 0, lastFiredAt: null, bypasses: 0 },
      createdAt: now,
      acceptedAt: now,
      updatedAt: now,
    });
    changed = true;
  }
  if (changed) writeRules(rules);
  return rules;
}

export interface BuiltinGate {
  tier: RuleTier;
  /** The user's text when it differs from the seed; null = keep the native message. */
  message: string | null;
  off: boolean;
}

const NATIVE_GATE: BuiltinGate = { tier: "deny", message: null, off: false };
let builtinCache: { mtime: number; gates: Map<string, BuiltinGate> } | null = null;

/** What the row says about a built-in gate. One `statSync` per call; the
 *  file is re-parsed only when it changed. Missing file or row → native. */
export function builtinGate(id: BuiltinRuleId): BuiltinGate {
  const path = practicePaths.rules();
  let mtime = -1;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return NATIVE_GATE;
  }
  if (!builtinCache || builtinCache.mtime !== mtime) {
    const gates = new Map<string, BuiltinGate>();
    for (const r of readRules()) {
      if (!r.builtin) continue;
      const seed = BUILTIN_SEEDS[r.id as BuiltinRuleId];
      const edited = seed ? r.message.trim() !== seed.message.trim() : true;
      gates.set(r.id, { tier: r.tier, message: edited ? r.message : null, off: r.status !== "active" });
    }
    builtinCache = { mtime, gates };
  }
  return builtinCache.gates.get(id) ?? NATIVE_GATE;
}

export function __resetBuiltinCacheForTests(): void {
  builtinCache = null;
}

/** A `deny` without a machine-checkable discharge is a wall, not a gate
 *  (advisor review, ADR-0105). Such a rule is enforced at `nudge`. */
export function effectiveTier(rule: Pick<PracticeRule, "tier" | "trigger" | "builtin">): RuleTier {
  if (rule.builtin) return rule.tier; // bespoke logic carries its own discharge
  if (rule.tier === "deny") {
    const discharge = rule.trigger?.requireSkillThisSession?.length ?? 0;
    return discharge > 0 ? "deny" : "nudge";
  }
  if (rule.tier === "nudge" && !rule.trigger) return "prompt";
  return rule.tier;
}

/** Denies per rule per turn before the call is let through and logged. */
export const PRACTICE_RULE_MAX_DENIES = 2;

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type FindingState =
  | "observed"
  | "proposed"
  | "active"
  | "regressed"
  | "confirmed"
  | "dismissed"
  | "report"
  | "practice"
  /** The user changed MARVIN's code for this. Verified like a rule: a
   *  recurrence after `fixedAt` is `regressed`, a quiet window `confirmed`. */
  | "fixed";

export interface LedgerSessionEntry {
  count: number;
  cost: number;
  lastAt: string;
  detail: string;
  /** Session file mtime when read — orders sessions without re-statting. */
  mtime: number;
}

export interface LedgerFinding {
  id: string;
  kind: FingerprintKind;
  polarity: "failure" | "success";
  state: FindingState;
  extractorVersion: number;
  firstSeen: string;
  lastSeen: string;
  sessions: Record<string, LedgerSessionEntry>;
  distinctSessions: number;
  costTotal: number;
  /** failures / (failures + paired successes), by distinct session; null when unpaired. */
  rate: number | null;
  value: number;
  proposedAt?: string;
  dismissedAt?: string;
  dismissReason?: string;
  dismissedAtSessions?: number;
  ruleId?: string;
  acceptedAt?: string;
  /** Set by "fixed in MARVIN": the verification clock for a code fix. */
  fixedAt?: string;
  fixNote?: string;
  /** Verification, for `active` / `regressed` / `confirmed` / `fixed`. */
  sessionsAfter?: number;
  recurrenceAfter?: number;
  /** Processed sessions newer than the last one this was seen in (decay input). */
  sessionsSinceLastSeen?: number;
}

export interface RunRecord {
  at: string;
  durationMs: number;
  sessionsRead: number;
  sessionsSkippedLive: number;
  occurrences: number;
  findingsNew: number;
  recurring: number;
  proposed: number;
  confirmed: number;
  regressed: number;
  trigger: "schedule" | "manual" | "backtest";
}

export interface Ledger {
  version: 1;
  projectId: string;
  extractorVersion: number;
  watermarks: Record<string, { mtime: number; size: number }>;
  findings: Record<string, LedgerFinding>;
  runs: RunRecord[];
}

const MAX_RUNS_KEPT = 60;

function practiceDir(): string {
  return join(marvinPaths.dataDir(), "practice");
}
export const practicePaths = {
  config: () => join(practiceDir(), "config.json"),
  rules: () => join(practiceDir(), "rules.json"),
  ledger: (projectId: string) => join(practiceDir(), projectId, "ledger.json"),
};

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

export function readPracticeConfig(): PracticeConfig {
  const raw = readJson<Partial<PracticeConfig>>(practicePaths.config(), {});
  return {
    ...DEFAULT_PRACTICE_CONFIG,
    ...raw,
    weights: { ...DEFAULT_PRACTICE_CONFIG.weights, ...(raw.weights ?? {}) },
    thresholds: { ...DEFAULT_PRACTICE_CONFIG.thresholds, ...(raw.thresholds ?? {}) },
    costScale: { ...DEFAULT_PRACTICE_CONFIG.costScale, ...(raw.costScale ?? {}) },
  };
}

export function writePracticeConfig(patch: Partial<PracticeConfig>): PracticeConfig {
  const next = readPracticeConfig();
  const merged: PracticeConfig = {
    ...next,
    ...patch,
    weights: { ...next.weights, ...(patch.weights ?? {}) },
    thresholds: { ...next.thresholds, ...(patch.thresholds ?? {}) },
    costScale: { ...next.costScale, ...(patch.costScale ?? {}) },
  };
  merged.hour = Math.min(23, Math.max(0, Math.round(merged.hour)));
  if (patch.fit === undefined && !("fit" in patch)) merged.fit = next.fit;
  writeJson(practicePaths.config(), merged);
  return merged;
}

export function readLedger(projectId: string): Ledger {
  return readJson<Ledger>(practicePaths.ledger(projectId), {
    version: 1,
    projectId,
    extractorVersion: EXTRACTOR_VERSION,
    watermarks: {},
    findings: {},
    runs: [],
  });
}

export function writeLedger(ledger: Ledger): void {
  writeJson(practicePaths.ledger(ledger.projectId), ledger);
}

interface RulesFile {
  version: 1;
  rules: PracticeRule[];
}

export function readRules(): PracticeRule[] {
  return readJson<RulesFile>(practicePaths.rules(), { version: 1, rules: [] }).rules;
}

export function writeRules(rules: PracticeRule[]): void {
  writeJson(practicePaths.rules(), { version: 1, rules });
}

/** Active rules that apply to a project: its own plus global ones. */
export function activeRulesFor(projectId: string, rules: PracticeRule[] = readRules()): PracticeRule[] {
  return rules.filter(
    (r) => r.status === "active" && (r.scope.projectId === null || r.scope.projectId === projectId),
  );
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoreInput {
  kind: FingerprintKind;
  distinctSessions: number;
  costTotal: number;
  rate: number | null;
  sessionsSinceLastSeen: number;
}

/**
 * ADR-0105 §3. Linear, explicit, tunable. Worked example with defaults:
 * `ship.unreviewed` seen in 3 sessions, 1 commit each, no paired success
 * (rate 1.0), seen last session →
 *   0.30·log2(4)/log2(9) + 0.20·min(1, 1/1) + 0.15·1.0 + 0.20·1 + 0.15·1 − 0 = 0.19+0.20+0.15+0.20+0.15 = 0.89.
 * `graph.first.skipped` in 3 of 40 structural turns, 7 reads each →
 *   0.19 + 0.20·(7/15) + 0.15·(3/40) + 0.20 + 0.15 = 0.19+0.093+0.011+0.20+0.15 = 0.64.
 */
export interface ScoreFactors {
  recurrence: number;
  cost: number;
  rate: number;
  reliability: number;
  actionability: number;
  decay: number;
}

/** The five positive factors and the decay penalty, each in [0, 1]. */
export function scoreFactors(input: ScoreInput, config: PracticeConfig = readPracticeConfig()): ScoreFactors {
  const kind = input.kind;
  const scale = config.costScale[kind] ?? 1;
  const perOccurrence = input.distinctSessions > 0 ? input.costTotal / input.distinctSessions : 0;
  return {
    recurrence: Math.min(1, Math.log2(1 + input.distinctSessions) / Math.log2(1 + 8)),
    cost: Math.min(1, perOccurrence / scale),
    rate: input.rate ?? 1,
    reliability: RELIABILITY[kind],
    actionability: RULE_TEMPLATES[kind] ? 1 : 0.2,
    decay: 1 - 0.9 ** Math.max(0, input.sessionsSinceLastSeen),
  };
}

export function scoreWithWeights(f: ScoreFactors, w: PracticeWeights): number {
  const v =
    w.recurrence * f.recurrence +
    w.cost * f.cost +
    w.rate * f.rate +
    w.reliability * f.reliability +
    w.actionability * f.actionability -
    w.decay * f.decay;
  return Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
}

export function scoreFinding(input: ScoreInput, config: PracticeConfig = readPracticeConfig()): number {
  return scoreWithWeights(scoreFactors(input, config), config.weights);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunOptions {
  now?: number;
  /** A transcript modified more recently than this is the live session — skipped. */
  liveGraceMs?: number;
  /** Ignore watermarks and re-read every transcript (the backtest). */
  force?: boolean;
  trigger?: RunRecord["trigger"];
  /** Test seam: read a transcript by session id. */
  readTranscript?: (projectId: string, sessionId: string) => string | null;
  /** Test seam: enumerate sessions. */
  listSessionFiles?: (projectId: string) => Array<{ sessionId: string; mtime: number; size: number }>;
}

function defaultListSessionFiles(projectId: string) {
  return listSessions(projectId).map((s) => {
    const path = marvinPaths.sessionFile(projectId, s.sessionId);
    let mtime = Date.parse(s.updatedAt);
    let size = s.bytes;
    try {
      const st = statSync(path);
      mtime = st.mtimeMs;
      size = st.size;
    } catch {
      /* keep the listing's values */
    }
    return { sessionId: s.sessionId, mtime, size };
  });
}

function defaultReadTranscript(projectId: string, sessionId: string): string | null {
  const path = marvinPaths.sessionFile(projectId, sessionId);
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function emptyFinding(id: string, kind: FingerprintKind, at: string): LedgerFinding {
  return {
    id,
    kind,
    polarity: POLARITY[kind],
    state: "observed",
    extractorVersion: EXTRACTOR_VERSION,
    firstSeen: at,
    lastSeen: at,
    sessions: {},
    distinctSessions: 0,
    costTotal: 0,
    rate: null,
    value: 0,
  };
}

/**
 * One run. Reads transcripts whose watermark moved, replaces each session's
 * entry in every finding it touches (so a session that grew is re-counted,
 * never double-counted), rescoring everything, then applies the day-two
 * transitions and verifies active rules.
 */
export function runPractice(projectId: string, opts: RunOptions = {}): RunRecord {
  const started = opts.now ?? Date.now();
  const wallStart = Date.now();
  const config = readPracticeConfig();
  const ledger = readLedger(projectId);
  const listFiles = opts.listSessionFiles ?? defaultListSessionFiles;
  const readTranscript = opts.readTranscript ?? defaultReadTranscript;
  const liveGrace = opts.liveGraceMs ?? 5 * 60 * 1000;

  // Extractor version bump: every count on file was produced by a different
  // definition. Reset to `observed` and re-read everything rather than
  // compare two measurements as if they were one.
  if (ledger.extractorVersion !== EXTRACTOR_VERSION) {
    ledger.watermarks = {};
    for (const f of Object.values(ledger.findings)) {
      if (f.state === "observed" || f.state === "proposed" || f.state === "report" || f.state === "practice") {
        f.sessions = {};
        f.state = "observed";
      }
      f.extractorVersion = EXTRACTOR_VERSION;
    }
    ledger.extractorVersion = EXTRACTOR_VERSION;
  }
  if (opts.force) ledger.watermarks = {};

  const files = listFiles(projectId);
  let sessionsRead = 0;
  let skippedLive = 0;
  let occurrencesTotal = 0;
  const statesBefore = new Map(Object.entries(ledger.findings).map(([id, f]) => [id, f.state]));
  const touched = new Set<string>();

  for (const file of files) {
    if (started - file.mtime < liveGrace) {
      skippedLive += 1;
      continue;
    }
    const wm = ledger.watermarks[file.sessionId];
    if (wm && wm.mtime === file.mtime && wm.size === file.size) continue;
    const raw = readTranscript(projectId, file.sessionId);
    if (raw === null) continue;
    const occurrences = extractAll(parseSessionTranscript(file.sessionId, raw), {
      turnOverbudgetUsd: config.thresholds.turnOverbudgetUsd,
    });
    sessionsRead += 1;
    occurrencesTotal += occurrences.length;

    // Drop this session's old entries everywhere, then re-add.
    for (const f of Object.values(ledger.findings)) delete f.sessions[file.sessionId];
    const bySession = new Map<string, LedgerSessionEntry & { first: string }>();
    for (const occ of occurrences) {
      const cur = bySession.get(occ.fingerprint) ?? {
        count: 0,
        cost: 0,
        lastAt: occ.at,
        detail: occ.detail,
        mtime: file.mtime,
        first: occ.at,
      };
      cur.count += 1;
      cur.cost += occ.cost;
      if (occ.at > cur.lastAt) {
        cur.lastAt = occ.at;
        cur.detail = occ.detail;
      }
      if (occ.at < cur.first) cur.first = occ.at;
      bySession.set(occ.fingerprint, cur);
    }
    for (const [fingerprint, entry] of bySession) {
      const kind = kindOf(fingerprint);
      if (!kind) continue;
      const f = ledger.findings[fingerprint] ?? emptyFinding(fingerprint, kind, entry.first);
      ledger.findings[fingerprint] = f;
      const { first, ...rest } = entry;
      f.sessions[file.sessionId] = rest;
      if (first < f.firstSeen) f.firstSeen = first;
      if (entry.lastAt > f.lastSeen) f.lastSeen = entry.lastAt;
      touched.add(fingerprint);
    }
    ledger.watermarks[file.sessionId] = { mtime: file.mtime, size: file.size };
  }

  // Sessions in processing order, for "since last seen" and "after acceptance".
  const processedMtimes = Object.entries(ledger.watermarks)
    .map(([, w]) => w.mtime)
    .sort((a, b) => a - b);
  const sessionsAfterTime = (t: number): number => processedMtimes.filter((m) => m > t).length;

  // Rescore + transitions.
  let findingsNew = 0;
  let recurring = 0;
  let proposed = 0;
  let confirmed = 0;
  let regressed = 0;
  const rules = readRules();
  const nowIso = new Date(started).toISOString();

  for (const f of Object.values(ledger.findings)) {
    const sessionsList = Object.values(f.sessions);
    f.distinctSessions = sessionsList.length;
    f.costTotal = sessionsList.reduce((a, s) => a + s.cost, 0);
    const lastMtime = sessionsList.reduce((a, s) => Math.max(a, s.mtime), 0);
    const sinceLastSeen = lastMtime ? sessionsAfterTime(lastMtime) : 0;
    f.sessionsSinceLastSeen = sinceLastSeen;

    // Rate against the paired success kind, by distinct session.
    const pair = SUCCESS_PAIR[f.kind];
    if (pair) {
      const s = ledger.findings[pair];
      const successSessions = s ? Object.keys(s.sessions).length : 0;
      const total = f.distinctSessions + successSessions;
      f.rate = total > 0 ? f.distinctSessions / total : null;
    } else {
      f.rate = null;
    }
    f.value = scoreFinding(
      {
        kind: f.kind,
        distinctSessions: f.distinctSessions,
        costTotal: f.costTotal,
        rate: f.rate,
        sessionsSinceLastSeen: sinceLastSeen,
      },
      config,
    );

    const before = statesBefore.get(f.id);
    if (!before) findingsNew += 1;
    else if (touched.has(f.id)) recurring += 1;

    if (f.polarity === "success") {
      f.state = f.distinctSessions >= config.thresholds.minSessions ? "practice" : "observed";
      continue;
    }

    const template = RULE_TEMPLATES[f.kind];
    // A finding back in the pool (dismissal lifted, rule retired) is judged
    // against the threshold in the SAME run — the evidence is already there.
    const promoteIfCrossed = (): void => {
      const crossed = f.distinctSessions >= config.thresholds.minSessions && f.value >= config.thresholds.minValue;
      if (!crossed) return;
      if (template) {
        f.state = "proposed";
        f.proposedAt = nowIso;
        proposed += 1;
      } else {
        f.state = "report";
      }
    };
    switch (f.state) {
      case "observed":
      case "report":
        promoteIfCrossed();
        break;
      case "dismissed": {
        const floor = (f.dismissedAtSessions ?? 0) * 2;
        if (floor > 0 && f.distinctSessions >= floor) {
          f.state = "observed";
          delete f.dismissedAt;
          delete f.dismissReason;
          delete f.dismissedAtSessions;
          promoteIfCrossed();
        }
        break;
      }
      case "fixed":
      case "active":
      case "regressed":
      case "confirmed": {
        const rule = f.ruleId ? rules.find((r) => r.id === f.ruleId && r.status === "active") : undefined;
        if (!rule && !f.fixedAt) {
          f.state = "observed";
          delete f.ruleId;
          delete f.acceptedAt;
          delete f.sessionsAfter;
          delete f.recurrenceAfter;
          promoteIfCrossed();
          break;
        }
        // A code fix and an accepted rule verify the same way; the clock is
        // whichever was set. A regressed FIX stays `regressed` (nothing to
        // escalate) until the user marks it fixed again or approves a rule.
        const acceptedMs = Date.parse(rule ? rule.acceptedAt : (f.fixedAt as string));
        f.sessionsAfter = sessionsAfterTime(acceptedMs);
        // A recurrence is an OCCURRENCE after acceptance, not a session file
        // touched after it: the session that was open when the rule landed
        // straddles the date, and its earlier hits are not evidence against
        // the rule. `lastAt` is the newest occurrence in that session.
        f.recurrenceAfter = sessionsList.filter((s) => Date.parse(s.lastAt) > acceptedMs).length;
        if (f.recurrenceAfter > 0) {
          if (f.state !== "regressed") regressed += 1;
          f.state = "regressed";
        } else if (f.sessionsAfter >= config.verifyWindow) {
          // Fired-and-held is a success: the rule met the act and the act
          // did not recur. Zero fires and zero recurrence is also confirmed —
          // the behaviour stopped, whichever tier did it.
          if (f.state !== "confirmed") confirmed += 1;
          f.state = "confirmed";
        } else {
          f.state = rule ? "active" : "fixed";
        }
        break;
      }
      case "proposed":
      case "practice":
        break;
    }
  }

  const record: RunRecord = {
    at: nowIso,
    durationMs: Date.now() - wallStart,
    sessionsRead,
    sessionsSkippedLive: skippedLive,
    occurrences: occurrencesTotal,
    findingsNew,
    recurring,
    proposed,
    confirmed,
    regressed,
    trigger: opts.trigger ?? (opts.force ? "backtest" : "manual"),
  };
  ledger.runs.push(record);
  if (ledger.runs.length > MAX_RUNS_KEPT) ledger.runs = ledger.runs.slice(-MAX_RUNS_KEPT);
  writeLedger(ledger);
  return record;
}

// ---------------------------------------------------------------------------
// Actions (the pane's verbs)
// ---------------------------------------------------------------------------

function newRuleId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface ApproveOptions {
  tier?: RuleTier;
  message?: string;
  global?: boolean;
}

export function approveFinding(
  projectId: string,
  findingId: string,
  opts: ApproveOptions = {},
): { ok: true; rule: PracticeRule } | { ok: false; error: string } {
  const ledger = readLedger(projectId);
  const f = ledger.findings[findingId];
  if (!f) return { ok: false, error: `unknown finding ${findingId}` };
  const template = RULE_TEMPLATES[f.kind];
  if (!template) return { ok: false, error: `${f.kind} is report-only — no rule template` };
  if (f.state === "active" || f.state === "confirmed") return { ok: false, error: "already has an active rule" };
  const now = new Date().toISOString();
  const rule: PracticeRule = {
    id: newRuleId(),
    fingerprint: f.id,
    title: template.title,
    tier: opts.tier ?? template.tier,
    trigger: template.trigger,
    message: (opts.message?.trim() || template.message).slice(0, 1200),
    status: "active",
    scope: { projectId: opts.global ? null : projectId },
    provenance: { findingId: f.id, distinctSessions: f.distinctSessions, costTotal: f.costTotal, value: f.value },
    metrics: { fired: 0, lastFiredAt: null, bypasses: 0 },
    createdAt: now,
    acceptedAt: now,
    updatedAt: now,
  };
  if (f.id.startsWith("hook.deny.repeated:")) {
    const gate = f.id.split(":")[1] ?? "a";
    rule.message = rule.message.replace("One of MARVIN's gates", `The ${gate} gate`);
  }
  const rules = readRules();
  rules.push(rule);
  writeRules(rules);
  f.state = "active";
  f.ruleId = rule.id;
  f.acceptedAt = now;
  f.sessionsAfter = 0;
  f.recurrenceAfter = 0;
  writeLedger(ledger);
  return { ok: true, rule };
}

/** "I changed MARVIN's code for this." Starts the same verification clock a
 *  rule gets, without a rule: the fix must hold across `verifyWindow`
 *  sessions or the finding comes back as `regressed`. */
export function markFindingFixed(projectId: string, findingId: string, note: string): boolean {
  const ledger = readLedger(projectId);
  const f = ledger.findings[findingId];
  if (!f || f.polarity === "success") return false;
  const now = new Date().toISOString();
  f.state = "fixed";
  f.fixedAt = now;
  f.fixNote = note.trim().slice(0, 300);
  f.sessionsAfter = 0;
  f.recurrenceAfter = 0;
  delete f.dismissedAt;
  delete f.dismissReason;
  delete f.dismissedAtSessions;
  writeLedger(ledger);
  return true;
}

export function dismissFinding(projectId: string, findingId: string, reason: string): boolean {
  const ledger = readLedger(projectId);
  const f = ledger.findings[findingId];
  if (!f) return false;
  f.state = "dismissed";
  delete f.fixedAt;
  delete f.fixNote;
  f.dismissedAt = new Date().toISOString();
  f.dismissReason = reason.trim().slice(0, 300);
  f.dismissedAtSessions = f.distinctSessions;
  writeLedger(ledger);
  return true;
}

/** A regressed rule moves one tier up; acceptance restarts so verification
 *  measures the new tier, not the old one. Never automatic. */
export function escalateFinding(
  projectId: string,
  findingId: string,
): { ok: true; rule: PracticeRule } | { ok: false; error: string } {
  const ledger = readLedger(projectId);
  const f = ledger.findings[findingId];
  if (!f?.ruleId) return { ok: false, error: "no rule to escalate" };
  const rules = readRules();
  const rule = rules.find((r) => r.id === f.ruleId);
  if (!rule) return { ok: false, error: "rule not found" };
  const idx = TIER_ORDER.indexOf(rule.tier);
  if (idx >= TIER_ORDER.length - 1) return { ok: false, error: "already at the top tier" };
  rule.tier = TIER_ORDER[idx + 1]!;
  const now = new Date().toISOString();
  rule.acceptedAt = now;
  rule.updatedAt = now;
  rule.metrics = { fired: 0, lastFiredAt: null, bypasses: 0 };
  writeRules(rules);
  f.state = "active";
  f.acceptedAt = now;
  f.sessionsAfter = 0;
  f.recurrenceAfter = 0;
  writeLedger(ledger);
  return { ok: true, rule };
}

export interface RulePatch {
  tier?: RuleTier;
  status?: RuleStatus;
  message?: string;
  global?: boolean;
}

export function updateRule(ruleId: string, patch: RulePatch): PracticeRule | null {
  const rules = readRules();
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return null;
  const now = new Date().toISOString();
  if (patch.tier && patch.tier !== rule.tier) {
    rule.tier = patch.tier;
    rule.acceptedAt = now;
    rule.metrics = { fired: 0, lastFiredAt: null, bypasses: 0 };
  }
  if (patch.status) rule.status = patch.status;
  if (typeof patch.message === "string" && patch.message.trim()) rule.message = patch.message.trim().slice(0, 1200);
  if (typeof patch.global === "boolean" && !rule.builtin) rule.scope.projectId = patch.global ? null : (rule.scope.projectId ?? null);
  rule.updatedAt = now;
  writeRules(rules);
  return rule;
}

export function retireRule(ruleId: string): boolean {
  return updateRule(ruleId, { status: "retired" }) !== null;
}

// ---------------------------------------------------------------------------
// Enforcement — called from the design hooks and the prompt builder
// ---------------------------------------------------------------------------

/** The `## Practice rules` block for the system prompt. Empty when none. */
export function practicePromptBlock(projectId: string, rules: PracticeRule[] = readRules()): string {
  const prompt = activeRulesFor(projectId, rules).filter((r) => effectiveTier(r) === "prompt");
  // A built-in at prompt tier is the user's explicit choice to move a gate
  // from the tool boundary into the prompt; anything else stays out.
  if (prompt.length === 0) return "";
  const lines = prompt.map((r) => `- **${r.title}.** ${r.message}`);
  return (
    "## Practice rules (ADR-0105)\n\n" +
    "Rules the user accepted from measured repeat failures in this project's own sessions. " +
    "They are MUSTs, not suggestions.\n\n" +
    lines.join("\n")
  );
}

export interface RuleEvalContext {
  projectId: string;
  toolName: string;
  input: Record<string, unknown>;
  counters: Partial<Record<RuleCondition["counter"], number>>;
  hasSkillRun: (skill: string) => boolean;
  /** Lazily computed by the caller — only invoked when a rule needs it. */
  boundaryHit: () => boolean;
  /** Denies already issued this turn, per rule id. Mutated. */
  deniesThisTurn: Map<string, number>;
  /** Nudges already issued this turn, per rule id. Mutated. */
  nudgesThisTurn: Set<string>;
  measure: boolean;
}

export interface RuleEvalResult {
  deny: { ruleId: string; message: string } | null;
  nudges: Array<{ ruleId: string; message: string }>;
  /** Denies that were skipped because the per-turn cap was reached. */
  bypassed: string[];
}

function conditionHolds(c: RuleCondition, counters: RuleEvalContext["counters"]): boolean {
  const v = counters[c.counter] ?? 0;
  if (c.op === "gte") return v >= c.value;
  if (c.op === "lte") return v <= c.value;
  return v === c.value;
}

function triggerMatches(t: RuleTrigger, ctx: RuleEvalContext): boolean {
  try {
    if (!new RegExp(t.tool).test(ctx.toolName)) return false;
    if (t.field && t.pattern) {
      const raw = ctx.input[t.field];
      const s = typeof raw === "string" ? raw : raw === undefined ? "" : JSON.stringify(raw);
      if (!new RegExp(t.pattern, "s").test(s)) return false;
    }
    if (t.conditions && !t.conditions.every((c) => conditionHolds(c, ctx.counters))) return false;
    if (t.requireSkillThisSession && t.requireSkillThisSession.some((s) => ctx.hasSkillRun(s))) return false;
    if (t.boundaryPaths && !ctx.boundaryHit()) return false;
    return true;
  } catch {
    return false; // a rule with a broken regex never fires
  }
}

export function evaluatePracticeRules(ctx: RuleEvalContext, rules: PracticeRule[] = readRules()): RuleEvalResult {
  const result: RuleEvalResult = { deny: null, nudges: [], bypassed: [] };
  for (const rule of activeRulesFor(ctx.projectId, rules)) {
    if (rule.builtin || !rule.trigger) continue;
    const tier = effectiveTier(rule);
    if (tier === "prompt") continue;
    if (!triggerMatches(rule.trigger, ctx)) continue;
    if (tier === "deny" && !ctx.measure) {
      const n = ctx.deniesThisTurn.get(rule.id) ?? 0;
      if (n >= PRACTICE_RULE_MAX_DENIES) {
        result.bypassed.push(rule.id);
        continue;
      }
      ctx.deniesThisTurn.set(rule.id, n + 1);
      if (!result.deny) result.deny = { ruleId: rule.id, message: rule.message };
      continue;
    }
    if (ctx.nudgesThisTurn.has(rule.id)) continue;
    ctx.nudgesThisTurn.add(rule.id);
    result.nudges.push({ ruleId: rule.id, message: rule.message });
  }
  return result;
}

/** Metrics travel with the rule (MemGuard's lesson): count every fire and bypass. */
export function notePracticeRuleFired(ruleId: string, kind: "fired" | "bypass"): void {
  const rules = readRules();
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return;
  if (kind === "fired") {
    rule.metrics.fired += 1;
    rule.metrics.lastFiredAt = new Date().toISOString();
  } else {
    rule.metrics.bypasses += 1;
  }
  writeRules(rules);
}

// ---------------------------------------------------------------------------
// Read model for the pane
// ---------------------------------------------------------------------------

/** A rule proven in another project, offered to this one (cold start). */
export interface StarterRule {
  ruleId: string;
  fingerprint: string;
  title: string;
  tier: RuleTier;
  message: string;
  /** Projects where this fingerprint's rule is confirmed. */
  confirmedIn: string[];
}

export interface PracticeView {
  projectId: string;
  config: PracticeConfig;
  /** Sessions the ledger has read so far — the cold-start counter. */
  sessionsSeen: number;
  /** Rules confirmed elsewhere and not yet present here. */
  starters: StarterRule[];
  findings: Array<LedgerFinding & { unit: string; template: boolean }>;
  /** Phase 6 — a project rule whose finding is confirmed here AND in other
   *  projects carries `suggestGlobal` with the count. */
  rules: Array<PracticeRule & { suggestGlobal?: boolean; confirmedIn?: number }>;
  runs: RunRecord[];
  lastRun: RunRecord | null;
}

export function practiceView(projectId: string): PracticeView {
  ensureBuiltinRules();
  const ledger = readLedger(projectId);
  const findings = Object.values(ledger.findings)
    .map((f) => ({ ...f, unit: COST_UNITS[f.kind], template: RULE_TEMPLATES[f.kind] !== null }))
    .sort((a, b) => b.value - a.value || b.distinctSessions - a.distinctSessions);
  const rules = readRules()
    .filter((r) => r.scope.projectId === null || r.scope.projectId === projectId)
    .map((r) => {
      if (r.builtin || r.scope.projectId === null || r.status !== "active") return r;
      const here = ledger.findings[r.fingerprint];
      if (here?.state !== "confirmed") return r;
      const confirmedIn = 1 + otherProjectsConfirmed(projectId, r.fingerprint);
      return confirmedIn >= 2 ? { ...r, suggestGlobal: true, confirmedIn } : { ...r, confirmedIn };
    });
  return {
    projectId,
    config: readPracticeConfig(),
    sessionsSeen: Object.keys(ledger.watermarks).length,
    starters: starterRulesFor(projectId, rules),
    findings,
    rules,
    runs: ledger.runs.slice(-20).reverse(),
    lastRun: ledger.runs[ledger.runs.length - 1] ?? null,
  };
}

/**
 * Cold start. A project MARVIN has never worked in has no findings for three
 * sessions, but the user's other projects already know what held: every
 * project-scoped, active, non-built-in rule whose finding is `confirmed` in
 * its own project, for a fingerprint this project has no rule for yet, is
 * offered. Adopting one creates a copy scoped here, verified here.
 */
export function starterRulesFor(projectId: string, here: PracticeRule[] = []): StarterRule[] {
  const present = new Set(here.filter((r) => r.status === "active").map((r) => r.fingerprint));
  const byFingerprint = new Map<string, StarterRule>();
  for (const r of readRules()) {
    if (r.builtin || r.status !== "active" || r.scope.projectId === null || r.scope.projectId === projectId) continue;
    if (present.has(r.fingerprint)) continue;
    const f = readLedger(r.scope.projectId).findings[r.fingerprint];
    if (f?.state !== "confirmed") continue;
    const cur = byFingerprint.get(r.fingerprint);
    if (cur) {
      if (!cur.confirmedIn.includes(r.scope.projectId)) cur.confirmedIn.push(r.scope.projectId);
    } else {
      byFingerprint.set(r.fingerprint, {
        ruleId: r.id,
        fingerprint: r.fingerprint,
        title: r.title,
        tier: r.tier,
        message: r.message,
        confirmedIn: [r.scope.projectId],
      });
    }
  }
  return [...byFingerprint.values()].sort((a, b) => b.confirmedIn.length - a.confirmedIn.length);
}

/** Copy a rule proven elsewhere into this project; its clock starts now. */
export function adoptRule(projectId: string, ruleId: string): { ok: true; rule: PracticeRule } | { ok: false; error: string } {
  const rules = readRules();
  const src = rules.find((r) => r.id === ruleId && r.status === "active" && !r.builtin);
  if (!src) return { ok: false, error: "unknown or retired rule" };
  if (rules.some((r) => r.status === "active" && r.fingerprint === src.fingerprint && (r.scope.projectId === projectId || r.scope.projectId === null))) {
    return { ok: false, error: "this project already has a rule for that finding" };
  }
  const now = new Date().toISOString();
  const rule: PracticeRule = {
    ...src,
    id: newRuleId(),
    scope: { projectId },
    provenance: { ...src.provenance, findingId: src.fingerprint },
    metrics: { fired: 0, lastFiredAt: null, bypasses: 0 },
    createdAt: now,
    acceptedAt: now,
    updatedAt: now,
  };
  rules.push(rule);
  writeRules(rules);
  // Let verification track it even before this project has the finding.
  const ledger = readLedger(projectId);
  const kind = kindOf(src.fingerprint);
  if (kind) {
    const f = ledger.findings[src.fingerprint] ?? emptyFinding(src.fingerprint, kind, now);
    f.state = "active";
    f.ruleId = rule.id;
    f.acceptedAt = now;
    f.sessionsAfter = 0;
    f.recurrenceAfter = 0;
    ledger.findings[src.fingerprint] = f;
    writeLedger(ledger);
  }
  return { ok: true, rule };
}

/** Other projects whose ledger has this fingerprint `confirmed`. */
export function otherProjectsConfirmed(projectId: string, fingerprint: string): number {
  let n = 0;
  for (const other of listLedgerProjectIds()) {
    if (other === projectId) continue;
    const f = readLedger(other).findings[fingerprint];
    if (f?.state === "confirmed") n += 1;
  }
  return n;
}

/** Every project that has a ledger on disk. */
export function listLedgerProjectIds(): string[] {
  try {
    return readdirSync(practiceDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(practicePaths.ledger(d.name)))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

let scheduleTimer: NodeJS.Timeout | null = null;
const lastRunDay = new Map<string, string>();

/**
 * Arm the nightly runner. Checks once a minute; fires each enabled project
 * once per local day at `config.hour`. Idempotent. Returns a stop function.
 */
export function armPracticeSchedule(args: {
  listProjectIds: () => string[];
  run?: (projectId: string) => void;
  intervalMs?: number;
  now?: () => Date;
}): () => void {
  if (scheduleTimer) clearInterval(scheduleTimer);
  const run = args.run ?? ((id: string) => runPractice(id, { trigger: "schedule" }));
  const now = args.now ?? (() => new Date());
  const tick = () => {
    const config = readPracticeConfig();
    if (!config.enabled) return;
    const d = now();
    if (d.getHours() !== config.hour) return;
    const day = d.toISOString().slice(0, 10);
    for (const projectId of args.listProjectIds()) {
      if (lastRunDay.get(projectId) === day) continue;
      lastRunDay.set(projectId, day);
      try {
        run(projectId);
      } catch {
        /* a failed run must never take the timer down */
      }
    }
  };
  scheduleTimer = setInterval(tick, args.intervalMs ?? 60_000);
  scheduleTimer.unref?.();
  return () => {
    if (scheduleTimer) clearInterval(scheduleTimer);
    scheduleTimer = null;
  };
}

/** Test seam. */
export function __resetPracticeScheduleForTests(): void {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = null;
  lastRunDay.clear();
}

export { COST_UNITS, EXTRACTOR_VERSION };
export type { Occurrence, FingerprintKind };
