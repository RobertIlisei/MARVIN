/**
 * Practice-loop extractors (ADR-0105).
 *
 * Deterministic functions from a parsed session transcript to *occurrences*
 * of a fingerprint. No model is involved anywhere in this file: the thing
 * being counted is a fact about the transcript, which is what makes the
 * ledger's day-two diff exact and the score's reliability factor honest.
 *
 * Adding a failure kind means adding an extractor here, a fixture in the
 * tests, and a rule template in `practice.ts`. Nothing else.
 */

export interface ParsedToolCall {
  /** Position within the turn, shared with text blocks, so "after" is exact. */
  seq: number;
  name: string;
  input: Record<string, unknown>;
  /** Set when the call came from a subagent. */
  parentId: string | null;
  /** First 400 characters of the tool_result, when one was seen. */
  result: string | null;
  isError: boolean;
}

export interface ParsedTurn {
  index: number;
  turnId: string | null;
  /** The human (or machine) message that started the turn. */
  message: string;
  /** True for wakeups / queued replays / auto-continues. */
  machine: boolean;
  startedAt: string;
  endedAt: string | null;
  tools: ParsedToolCall[];
  texts: string[];
  /** Same text as `texts`, with the position each block appeared at. */
  textBlocks: Array<{ seq: number; text: string }>;
  lastText: string;
  error: string | null;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface ParsedSession {
  sessionId: string;
  turns: ParsedTurn[];
}

/** One hit of a fingerprint inside one session. */
export interface Occurrence {
  fingerprint: string;
  sessionId: string;
  turnId: string | null;
  at: string;
  /** In the kind's cost unit (see `COST_UNITS`). */
  cost: number;
  detail: string;
}

export const FINGERPRINT_KINDS = [
  // Failures — what a rule exists to stop.
  "ship.unreviewed",
  "graph.first.skipped",
  "turn.stalled",
  "scope.met.missing",
  "cache.recreated",
  "hook.deny.repeated",
  "error.repeated",
  // Successes — the same acts done right. Each pairs with a failure above so
  // the ledger can score a RATE, not a raw count: five skipped turns out of
  // two hundred is not five out of six. They are also the verification
  // signal for an accepted rule (a review that ran before a boundary commit
  // is the ship-review gate holding), and they surface in the pane as what
  // is working — the half of the loop that is not about mistakes.
  "ship.reviewed",
  "graph.first.followed",
  "turn.continued",
  "scope.met.present",
  // Phase 2 (ADR-0105 § Phases): what the first backtest could not see.
  "skill.bypassed",
  "review.ignored",
  "plan.stale",
  "command.retried",
  "turn.overbudget",
  "skill.invoked",
  "review.acted",
  "plan.kept",
  "command.adapted",
] as const;
export type FingerprintKind = (typeof FINGERPRINT_KINDS)[number];

export type Polarity = "failure" | "success";

export const POLARITY: Record<FingerprintKind, Polarity> = {
  "ship.unreviewed": "failure",
  "graph.first.skipped": "failure",
  "turn.stalled": "failure",
  "scope.met.missing": "failure",
  "cache.recreated": "failure",
  "hook.deny.repeated": "failure",
  "error.repeated": "failure",
  "ship.reviewed": "success",
  "graph.first.followed": "success",
  "turn.continued": "success",
  "scope.met.present": "success",
  "skill.bypassed": "failure",
  "review.ignored": "failure",
  "plan.stale": "failure",
  "command.retried": "failure",
  "turn.overbudget": "failure",
  "skill.invoked": "success",
  "review.acted": "success",
  "plan.kept": "success",
  "command.adapted": "success",
};

/** failure kind → the success kind that counts the same opportunity done right. */
export const SUCCESS_PAIR: Partial<Record<FingerprintKind, FingerprintKind>> = {
  "ship.unreviewed": "ship.reviewed",
  "graph.first.skipped": "graph.first.followed",
  "turn.stalled": "turn.continued",
  "scope.met.missing": "scope.met.present",
  "skill.bypassed": "skill.invoked",
  "review.ignored": "review.acted",
  "plan.stale": "plan.kept",
  "command.retried": "command.adapted",
};

export const COST_UNITS: Record<FingerprintKind, string> = {
  "ship.unreviewed": "commits",
  "graph.first.skipped": "reads",
  "turn.stalled": "seconds waited",
  "scope.met.missing": "turns",
  "cache.recreated": "tokens",
  "hook.deny.repeated": "denies",
  "error.repeated": "turns",
  "ship.reviewed": "commits",
  "graph.first.followed": "turns",
  "turn.continued": "turns",
  "scope.met.present": "turns",
  "skill.bypassed": "reads",
  "review.ignored": "turns",
  "plan.stale": "turns",
  "command.retried": "retries",
  "turn.overbudget": "USD",
  "skill.invoked": "turns",
  "review.acted": "turns",
  "plan.kept": "turns",
  "command.adapted": "turns",
};

export function kindOf(fingerprint: string): FingerprintKind | null {
  const kind = fingerprint.split(":")[0] as FingerprintKind;
  return (FINGERPRINT_KINDS as readonly string[]).includes(kind) ? kind : null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const SCOPE_MET_SENTINEL = "<!-- marvin:scope-met -->";

/**
 * Parse a JSONL transcript into turns. Tolerant: a malformed line is skipped,
 * a turn with no completion record is closed by the next `turn.user`.
 */
export function parseSessionTranscript(sessionId: string, raw: string): ParsedSession {
  const turns: ParsedTurn[] = [];
  let cur: ParsedTurn | null = null;
  const toolIndex = new Map<string, ParsedToolCall>();
  let seq = 0;

  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = o.type as string;
    const at = typeof o.at === "string" ? o.at : "";
    if (type === "turn.user") {
      const message = typeof o.message === "string" ? o.message : "";
      seq = 0;
      cur = {
        index: turns.length,
        turnId: null,
        message,
        machine: /^\[(scheduled wakeup|queued |\d+ messages queued)/.test(message),
        startedAt: at,
        endedAt: null,
        tools: [],
        texts: [],
        textBlocks: [],
        lastText: "",
        error: null,
        cacheCreationTokens: 0,
        costUsd: 0,
      };
      turns.push(cur);
      continue;
    }
    if (!cur) continue;
    if (type === "turn.started") {
      if (typeof o.turnId === "string") cur.turnId = o.turnId;
    } else if (type === "turn.completed") {
      cur.endedAt = at;
      const usage = o.tokenUsage as { cache_creation_input_tokens?: number } | null;
      cur.cacheCreationTokens = usage?.cache_creation_input_tokens ?? 0;
      cur.costUsd = typeof o.costUsd === "number" ? o.costUsd : 0;
    } else if (type === "turn.error") {
      cur.endedAt = at;
      cur.error = typeof o.error === "string" ? o.error : "error";
    } else if (type === "cli.event") {
      const ev = o.event as Record<string, unknown> | undefined;
      if (!ev) continue;
      const msg = ev.message as { content?: unknown } | undefined;
      const content = Array.isArray(msg?.content) ? (msg?.content as Array<Record<string, unknown>>) : [];
      if (ev.type === "assistant") {
        for (const b of content) {
          if (b.type === "tool_use") {
            const call: ParsedToolCall = {
              seq: ++seq,
              name: String(b.name ?? ""),
              input:
                b.input && typeof b.input === "object" && !Array.isArray(b.input)
                  ? (b.input as Record<string, unknown>)
                  : {},
              parentId: typeof ev.parent_tool_use_id === "string" ? ev.parent_tool_use_id : null,
              result: null,
              isError: false,
            };
            cur.tools.push(call);
            if (typeof b.id === "string") toolIndex.set(b.id, call);
          } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            cur.texts.push(b.text);
            cur.textBlocks.push({ seq: ++seq, text: b.text });
            cur.lastText = b.text;
          }
        }
      } else if (ev.type === "user") {
        for (const b of content) {
          if (b.type !== "tool_result") continue;
          const call = typeof b.tool_use_id === "string" ? toolIndex.get(b.tool_use_id) : undefined;
          if (!call) continue;
          const c = b.content;
          const text =
            typeof c === "string"
              ? c
              : Array.isArray(c)
                ? (c as Array<Record<string, unknown>>)
                    .map((x) => (typeof x.text === "string" ? x.text : ""))
                    .join("\n")
                : "";
          call.result = text.slice(0, 400);
          call.isError = b.is_error === true;
        }
      }
    }
  }
  return { sessionId, turns };
}

// ---------------------------------------------------------------------------
// Shared predicates
// ---------------------------------------------------------------------------

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|swift|py|go|rs|c|cc|cpp|h|hpp|java|kt|rb|php|cs|scala|m|mm)$/i;
const READ_SHAPED_BASH = /^\s*(cat|sed\s+-n|head|tail|grep|rg|find|awk|less|bat)\b/;
const REVIEW_SKILL = /(^|:)(pr-review|security-audit)$/;
const COMMIT_CMD = /\bgit\b[^|;&\n]*\bcommit\b/;
const SHIP_BOUNDARY =
  /(^|\/)(auth|login|session|credentials?|migrations?|schema|policy|permission|secrets?)(\/|\.|$)|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)\.github\/workflows\/|(^|\/)(Jenkinsfile|sudoers|Dockerfile|docker-compose|compose\.[a-z0-9.-]*ya?ml)|(^|\/)\.env(\.|$)|\.(sh|bash|zsh|sql)$|(token|password|passwd|keychain|sandbox|tool-policy)/i;
const HOOK_DENY_PREFIXES: Array<{ rule: string; regex: RegExp }> = [
  { rule: "graphify-first", regex: /graphify-first/ },
  { rule: "graph-drift", regex: /graph-drift|drift deny/ },
  { rule: "advisor-on-adr-trigger", regex: /advisor-on-ADR-trigger/ },
  { rule: "advisor-verdict", regex: /advisor (rejected|verdict)/i },
  { rule: "ship-review", regex: /ship-review gate/ },
  { rule: "subagent-read-only", regex: /subagent.*read-only|read-only.*subagent/i },
];

/** Every extractor reasons about MARVIN's own calls. A scout (ADR-0014) or
 *  an Explore legitimately opens twenty files with no graph call, and its
 *  denies are its own; counting them would propose rules against the
 *  sanctioned pattern. */
function ownCalls(turn: ParsedTurn): ParsedToolCall[] {
  return turn.tools.filter((c) => !c.parentId);
}

function isSourceRead(call: ParsedToolCall): boolean {
  if (call.parentId) return false;
  if (call.name === "Read") {
    const p = typeof call.input.file_path === "string" ? call.input.file_path : "";
    return SOURCE_EXT.test(p);
  }
  if (call.name === "Bash") {
    const cmd = typeof call.input.command === "string" ? call.input.command : "";
    return READ_SHAPED_BASH.test(cmd);
  }
  return false;
}

function isGraphCall(call: ParsedToolCall): boolean {
  return call.name.startsWith("mcp__marvin-graph__");
}

function secondsBetween(a: string, b: string): number {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return 0;
  return Math.max(0, (y - x) / 1000);
}

/** Ported from `scripts/session-time-breakdown.py` (ADR-0067, ADR-0104). */
export function classifyTurnEnding(
  lastText: string,
): "background" | "blocked-on-human" | "asked" | "scope-met" | "stopped" | "empty" {
  const e = lastText.toLowerCase();
  if (!lastText.trim()) return "empty";
  if (lastText.includes(SCOPE_MET_SENTINEL) || /\*\*scope met:\*\*/i.test(lastText)) return "scope-met";
  if (/wakeup|background job|pick back up automatically|polling|watching (for|the|it)/.test(e)) return "background";
  if (
    /waiting on you|waiting for you|let me know when|once (that|it)'?s (pushed|merged|approved|done)|needs? your (go-ahead|review|approval|read|sign-off|audit)|your call|before i touch|i('| wi)ll wait for your|when you('|')?ve|after you (push|merge|approve|review)|blocked on you|i'll check with you before|wait for your go-ahead/.test(
      e,
    )
  ) {
    return "blocked-on-human";
  }
  if (lastText.trimEnd().endsWith("?") || /want me to|approve to|should i |or handle a subset|shall i /.test(e)) {
    return "asked";
  }
  return "stopped";
}

const BARE_CONTINUE = /^\s*(continue|proceed|go on|resume|carry on|keep going|go ahead|next)\b[\s.!,]*$/i;

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

export type Extractor = (session: ParsedSession) => Occurrence[];

/** Boundary commits, split by whether a review skill ran earlier in the
 *  session. Without a repository the extractor cannot read the index, so it
 *  is conservative: only commits whose own command line names a boundary path
 *  count, in either direction. */
function shipCommits(s: ParsedSession): Occurrence[] {
  const out: Occurrence[] = [];
  let reviewed = false;
  for (const turn of s.turns) {
    for (const call of ownCalls(turn)) {
      if (call.name === "Skill") {
        const skill = typeof call.input.skill === "string" ? call.input.skill : "";
        if (REVIEW_SKILL.test(skill)) reviewed = true;
        continue;
      }
      if (call.name !== "Bash") continue;
      const cmd = typeof call.input.command === "string" ? call.input.command : "";
      if (!COMMIT_CMD.test(cmd)) continue;
      if (call.isError) continue; // the gate refused it — that is a rule holding, not a commit
      const named = cmd.match(/[\w./-]+\.[a-z]{1,5}\b|\.gitlab-ci\.ya?ml|Dockerfile|sudoers/gi) ?? [];
      const boundary = named.filter((p) => SHIP_BOUNDARY.test(p));
      if (boundary.length === 0) continue;
      out.push({
        fingerprint: reviewed ? "ship.reviewed" : "ship.unreviewed",
        sessionId: s.sessionId,
        turnId: turn.turnId,
        at: turn.startedAt,
        cost: 1,
        detail: reviewed
          ? `commit touching ${boundary.slice(0, 3).join(", ")} after a review skill ran`
          : `commit touching ${boundary.slice(0, 3).join(", ")} with no pr-review / security-audit this session`,
      });
    }
  }
  return out;
}
const shipUnreviewed: Extractor = (s) => shipCommits(s).filter((o) => o.fingerprint === "ship.unreviewed");
const shipReviewed: Extractor = (s) => shipCommits(s).filter((o) => o.fingerprint === "ship.reviewed");

/** Turns that did structural reading, split by whether the graph came first.
 *  The opportunity is "≥ 5 source reads this turn"; the success is a graph
 *  call before the fifth of them. */
function graphFirstTurns(s: ParsedSession): Occurrence[] {
  const out: Occurrence[] = [];
  for (const turn of s.turns) {
    let readsBeforeGraph = 0;
    let totalReads = 0;
    let graphSeen = false;
    for (const call of ownCalls(turn)) {
      if (isGraphCall(call)) graphSeen = true;
      if (isSourceRead(call)) {
        totalReads += 1;
        if (!graphSeen) readsBeforeGraph += 1;
      }
    }
    if (totalReads < 5) continue;
    if (readsBeforeGraph >= 5) {
      out.push({
        fingerprint: "graph.first.skipped",
        sessionId: s.sessionId,
        turnId: turn.turnId,
        at: turn.startedAt,
        cost: readsBeforeGraph,
        detail: graphSeen
          ? `${readsBeforeGraph} source reads before the first graph call`
          : `${readsBeforeGraph} source reads and no graph call at all`,
      });
    } else {
      out.push({
        fingerprint: "graph.first.followed",
        sessionId: s.sessionId,
        turnId: turn.turnId,
        at: turn.startedAt,
        cost: 1,
        detail: `graph consulted before ${totalReads} source reads`,
      });
    }
  }
  return out;
}
const graphFirstSkipped: Extractor = (s) => graphFirstTurns(s).filter((o) => o.fingerprint === "graph.first.skipped");
const graphFirstFollowed: Extractor = (s) => graphFirstTurns(s).filter((o) => o.fingerprint === "graph.first.followed");

/** Human turns that ended, split by how. The classifier is the breakdown
 *  script's, verbatim (ADR-0067 / ADR-0104); the bare "continue" reply is an
 *  EXTRA precision filter on the failure side, so this can only be stricter
 *  than the script, never disagree with it in the other direction. */
function turnEndings(s: ParsedSession): Occurrence[] {
  const out: Occurrence[] = [];
  for (let i = 0; i < s.turns.length - 1; i++) {
    const turn = s.turns[i]!;
    const next = s.turns[i + 1]!;
    if (turn.machine || next.machine || turn.error) continue;
    const ending = classifyTurnEnding(turn.lastText);
    if (ending === "stopped" && BARE_CONTINUE.test(next.message)) {
      const waited = turn.endedAt ? secondsBetween(turn.endedAt, next.startedAt) : 0;
      out.push({
        fingerprint: "turn.stalled",
        sessionId: s.sessionId,
        turnId: turn.turnId,
        at: turn.endedAt ?? turn.startedAt,
        cost: waited,
        detail: `ended without a question; user replied "${next.message.trim().slice(0, 20)}" after ${Math.round(waited)}s`,
      });
    } else if (ending === "scope-met" || ending === "asked" || ending === "blocked-on-human") {
      out.push({
        fingerprint: "turn.continued",
        sessionId: s.sessionId,
        turnId: turn.turnId,
        at: turn.endedAt ?? turn.startedAt,
        cost: 1,
        detail: `turn ended on a ${ending} boundary`,
      });
    }
  }
  return out;
}
const turnStalled: Extractor = (s) => turnEndings(s).filter((o) => o.fingerprint === "turn.stalled");
const turnContinued: Extractor = (s) => turnEndings(s).filter((o) => o.fingerprint === "turn.continued");

/** Real-work turns (≥ 1 edit, ≥ 10 own tool calls), split by whether they
 *  handed off with the scope-met block. */
function scopeMetTurns(s: ParsedSession): Occurrence[] {
  const out: Occurrence[] = [];
  for (const turn of s.turns) {
    if (turn.machine || turn.error) continue;
    const own = ownCalls(turn);
    const mutations = own.filter((c) => c.name === "Edit" || c.name === "Write").length;
    if (mutations < 1 || own.length < 10) continue;
    const ending = classifyTurnEnding(turn.lastText);
    // A question is a handoff too (ADR-0067 gates on a real trade-off); only
    // a turn that simply stopped, or ended empty, is missing its handoff.
    if (ending === "background" || ending === "blocked-on-human" || ending === "asked") continue;
    const present = ending === "scope-met";
    out.push({
      fingerprint: present ? "scope.met.present" : "scope.met.missing",
      sessionId: s.sessionId,
      turnId: turn.turnId,
      at: turn.endedAt ?? turn.startedAt,
      cost: 1,
      detail: present
        ? `${mutations} edits, ${own.length} tool calls, handed off with scope-met`
        : `${mutations} edits, ${own.length} tool calls, no scope-met handoff`,
    });
  }
  return out;
}
const scopeMetMissing: Extractor = (s) => scopeMetTurns(s).filter((o) => o.fingerprint === "scope.met.missing");
const scopeMetPresent: Extractor = (s) => scopeMetTurns(s).filter((o) => o.fingerprint === "scope.met.present");

export const CACHE_RECREATED_THRESHOLD = 300_000;

/** `cache_creation_input_tokens` is the SDK's per-turn total as recorded on
 *  `turn.completed` (one value per turn, not per message). Report-only: the
 *  remaining re-creations come from the Claude Code preset's git-status
 *  snapshot, which is not MARVIN's behaviour to change (ADR-0104). */
const cacheRecreated: Extractor = (s) => {
  const out: Occurrence[] = [];
  for (const turn of s.turns) {
    if (turn.cacheCreationTokens < CACHE_RECREATED_THRESHOLD) continue;
    out.push({
      fingerprint: "cache.recreated",
      sessionId: s.sessionId,
      turnId: turn.turnId,
      at: turn.endedAt ?? turn.startedAt,
      cost: turn.cacheCreationTokens,
      detail: `${turn.cacheCreationTokens} cache-creation tokens in one turn ($${turn.costUsd.toFixed(2)})`,
    });
  }
  return out;
};

/** Denies the model was told about and hit AGAIN in the same turn. Measured
 *  2026-09-03: after an advisor-gate deny, 80 % of next calls were the advisor
 *  consult — the gate working. Counting every deny scored gate USE as a
 *  failure; only the second and later denies of one rule within one turn
 *  are the model ignoring what it was just told. */
const hookDenyRepeated: Extractor = (s) => {
  const repeats = new Map<string, { n: number; at: string; turnId: string | null }>();
  for (const turn of s.turns) {
    const seenThisTurn = new Map<string, number>();
    for (const call of ownCalls(turn)) {
      if (!call.isError || !call.result) continue;
      for (const { rule, regex } of HOOK_DENY_PREFIXES) {
        if (!regex.test(call.result)) continue;
        const k = (seenThisTurn.get(rule) ?? 0) + 1;
        seenThisTurn.set(rule, k);
        if (k >= 2) {
          const cur = repeats.get(rule) ?? { n: 0, at: turn.startedAt, turnId: turn.turnId };
          cur.n += 1;
          repeats.set(rule, cur);
        }
        break;
      }
    }
  }
  const out: Occurrence[] = [];
  for (const [rule, { n, at, turnId }] of repeats) {
    if (n < 2) continue;
    out.push({
      fingerprint: `hook.deny.repeated:${rule}`,
      sessionId: s.sessionId,
      turnId,
      at,
      cost: n,
      detail: `the ${rule} gate was hit again ${n} times in the same turn after a deny`,
    });
  }
  return out;
};

const TRANSIENT_ERROR = /aborted by user|stream idle|ECONNRESET|socket hang up|timeout|rate.?limit|overloaded|529|502|503/i;

const errorRepeated: Extractor = (s) => {
  const byText = new Map<string, { n: number; at: string; turnId: string | null }>();
  for (const turn of s.turns) {
    if (!turn.error || TRANSIENT_ERROR.test(turn.error)) continue;
    const key = turn.error.replace(/\d+/g, "#").slice(0, 120);
    const cur = byText.get(key) ?? { n: 0, at: turn.endedAt ?? turn.startedAt, turnId: turn.turnId };
    cur.n += 1;
    byText.set(key, cur);
  }
  const out: Occurrence[] = [];
  for (const [text, { n, at, turnId }] of byText) {
    if (n < 2) continue;
    out.push({
      fingerprint: "error.repeated",
      sessionId: s.sessionId,
      turnId,
      at,
      cost: n,
      detail: `"${text.slice(0, 80)}" ended ${n} turns`,
    });
  }
  return out;
};

// ---------------------------------------------------------------------------
// Phase 2 extractors
// ---------------------------------------------------------------------------

const SKILL_DIR = /(^|[\/\s])\.(claude|marvin)\/skills\/([A-Za-z0-9._-]+)(?:\/|\s|$)/;
const skillBase = (name: string): string => (name.split(":").pop() ?? name).trim().toLowerCase();

/** Skills read by hand vs invoked. A `Read` (or read-shaped Bash) into a
 *  skill's folder with no `Skill` call for that name earlier in the turn is
 *  the model re-deriving what the tool would have loaded for it. */
function skillUsage(s: ParsedSession): Occurrence[] {
  const out: Occurrence[] = [];
  for (const turn of s.turns) {
    const own = ownCalls(turn);
    const invoked = new Map<string, number>(); // name → seq
    let anySkill = false;
    const bypassed = new Map<string, number>();
    for (const call of own) {
      if (call.name === "Skill") {
        const name = typeof call.input.skill === "string" ? skillBase(call.input.skill) : "";
        if (name) {
          invoked.set(name, call.seq);
          anySkill = true;
        }
        continue;
      }
      let target = "";
      if (call.name === "Read") target = typeof call.input.file_path === "string" ? call.input.file_path : "";
      else if (call.name === "Bash") {
        const cmd = typeof call.input.command === "string" ? call.input.command : "";
        if (READ_SHAPED_BASH.test(cmd)) target = cmd;
      }
      const m = target ? SKILL_DIR.exec(target) : null;
      if (!m) continue;
      const name = (m[3] ?? "").toLowerCase();
      const at = invoked.get(name);
      if (at !== undefined && at < call.seq) continue;
      bypassed.set(name, (bypassed.get(name) ?? 0) + 1);
    }
    for (const [name, reads] of bypassed) {
      out.push({
        fingerprint: `skill.bypassed:${name}`,
        sessionId: s.sessionId,
        turnId: turn.turnId,
        at: turn.startedAt,
        cost: reads,
        detail: `read ${reads} file${reads === 1 ? "" : "s"} of the \`${name}\` skill by hand instead of invoking it`,
      });
    }
    if (anySkill) {
      out.push({
        fingerprint: "skill.invoked",
        sessionId: s.sessionId,
        turnId: turn.turnId,
        at: turn.startedAt,
        cost: 1,
        detail: `invoked ${[...invoked.keys()].slice(0, 3).join(", ")} through the Skill tool`,
      });
    }
  }
  return out;
}
const skillBypassed: Extractor = (s) => skillUsage(s).filter((o) => o.fingerprint.startsWith("skill.bypassed:"));
const skillInvoked: Extractor = (s) => skillUsage(s).filter((o) => o.fingerprint === "skill.invoked");

/** The two review skills' documented finding formats. Conservative: nit-only
 *  or clean reports do not count as findings. */
const REVIEW_FINDINGS = /\[(Important|CRITICAL|HIGH)\]|🔴|\b[1-9]\d* (important|critical|high)\b/i;

function reviewOutcome(s: ParsedSession): Occurrence[] {
  const out: Occurrence[] = [];
  for (const turn of s.turns) {
    const own = ownCalls(turn);
    const review = own.find(
      (c) => c.name === "Skill" && typeof c.input.skill === "string" && REVIEW_SKILL.test(c.input.skill),
    );
    if (!review) continue;
    const findings = turn.textBlocks.some((b) => b.seq > review.seq && REVIEW_FINDINGS.test(b.text));
    if (!findings) continue;
    const acted = own.some((c) => c.seq > review.seq && (c.name === "Edit" || c.name === "Write"));
    out.push({
      fingerprint: acted ? "review.acted" : "review.ignored",
      sessionId: s.sessionId,
      turnId: turn.turnId,
      at: turn.startedAt,
      cost: 1,
      detail: acted
        ? "a review skill reported findings and edits followed in the same turn"
        : "a review skill reported findings and nothing was edited afterwards in the turn",
    });
  }
  return out;
}
const reviewIgnored: Extractor = (s) => reviewOutcome(s).filter((o) => o.fingerprint === "review.ignored");
const reviewActed: Extractor = (s) => reviewOutcome(s).filter((o) => o.fingerprint === "review.acted");

/** A plan that was started (a TodoWrite in an earlier turn) and then left
 *  behind by a turn that did real work without touching it — or the next. */
function planTracking(s: ParsedSession): Occurrence[] {
  const out: Occurrence[] = [];
  let todoSeen = false;
  const hasTodo = (t: ParsedTurn): boolean => ownCalls(t).some((c) => c.name === "TodoWrite");
  for (let i = 0; i < s.turns.length; i++) {
    const turn = s.turns[i]!;
    const seenBefore = todoSeen;
    if (hasTodo(turn)) todoSeen = true;
    if (!seenBefore || turn.machine || i === s.turns.length - 1) continue;
    const edits = ownCalls(turn).filter((c) => c.name === "Edit" || c.name === "Write").length;
    if (edits < 3) continue;
    const kept = hasTodo(turn) || hasTodo(s.turns[i + 1]!);
    out.push({
      fingerprint: kept ? "plan.kept" : "plan.stale",
      sessionId: s.sessionId,
      turnId: turn.turnId,
      at: turn.startedAt,
      cost: 1,
      detail: kept
        ? `${edits} edits with the plan updated in this turn or the next`
        : `${edits} edits and the plan's TodoWrite was not touched in this turn or the next`,
    });
  }
  return out;
}
const planStale: Extractor = (s) => planTracking(s).filter((o) => o.fingerprint === "plan.stale");
const planKept: Extractor = (s) => planTracking(s).filter((o) => o.fingerprint === "plan.kept");

/** The same failing command run again unchanged. */
function commandRetries(s: ParsedSession): Occurrence[] {
  const out: Occurrence[] = [];
  for (const turn of s.turns) {
    const failures = new Map<string, number>();
    for (const c of ownCalls(turn)) {
      if (c.name !== "Bash" || !c.isError) continue;
      const cmd = typeof c.input.command === "string" ? c.input.command.replace(/\s+/g, " ").trim() : "";
      if (!cmd) continue;
      failures.set(cmd, (failures.get(cmd) ?? 0) + 1);
    }
    if (failures.size === 0) continue;
    let repeats = 0;
    let worst = "";
    for (const [cmd, n] of failures) {
      if (n >= 2) {
        repeats += n - 1;
        if (!worst) worst = cmd;
      }
    }
    if (repeats > 0) {
      out.push({
        fingerprint: "command.retried",
        sessionId: s.sessionId,
        turnId: turn.turnId,
        at: turn.startedAt,
        cost: repeats,
        detail: `\`${worst.slice(0, 60)}\` failed and was re-run unchanged ${repeats} time${repeats === 1 ? "" : "s"}`,
      });
    } else {
      out.push({
        fingerprint: "command.adapted",
        sessionId: s.sessionId,
        turnId: turn.turnId,
        at: turn.startedAt,
        cost: 1,
        detail: "a command failed and was not re-run unchanged",
      });
    }
  }
  return out;
}
const commandRetried: Extractor = (s) => commandRetries(s).filter((o) => o.fingerprint === "command.retried");
const commandAdapted: Extractor = (s) => commandRetries(s).filter((o) => o.fingerprint === "command.adapted");

export interface ExtractorOptions {
  /** `turn.completed.costUsd` at or above this is over budget. */
  turnOverbudgetUsd?: number;
}
export const DEFAULT_TURN_OVERBUDGET_USD = 10;

let overbudgetThreshold = DEFAULT_TURN_OVERBUDGET_USD;
/** Report-only (the remedy is a MARVIN or context decision, not a rule). */
const turnOverbudget: Extractor = (s) => {
  const out: Occurrence[] = [];
  for (const turn of s.turns) {
    if (turn.costUsd < overbudgetThreshold) continue;
    out.push({
      fingerprint: "turn.overbudget",
      sessionId: s.sessionId,
      turnId: turn.turnId,
      at: turn.endedAt ?? turn.startedAt,
      cost: turn.costUsd,
      detail: `one turn cost $${turn.costUsd.toFixed(2)} (threshold $${overbudgetThreshold})`,
    });
  }
  return out;
};

export const EXTRACTORS: Record<FingerprintKind, Extractor> = {
  "ship.unreviewed": shipUnreviewed,
  "graph.first.skipped": graphFirstSkipped,
  "turn.stalled": turnStalled,
  "scope.met.missing": scopeMetMissing,
  "cache.recreated": cacheRecreated,
  "hook.deny.repeated": hookDenyRepeated,
  "error.repeated": errorRepeated,
  "ship.reviewed": shipReviewed,
  "graph.first.followed": graphFirstFollowed,
  "turn.continued": turnContinued,
  "scope.met.present": scopeMetPresent,
  "skill.bypassed": skillBypassed,
  "review.ignored": reviewIgnored,
  "plan.stale": planStale,
  "command.retried": commandRetried,
  "turn.overbudget": turnOverbudget,
  "skill.invoked": skillInvoked,
  "review.acted": reviewActed,
  "plan.kept": planKept,
  "command.adapted": commandAdapted,
};

/** Bump when an extractor's definition changes; the ledger records it per
 *  finding so a count produced by an older definition is never compared
 *  against one from a newer definition as if they were the same measurement. */
export const EXTRACTOR_VERSION = 3; // v3 (2026-09-03): Phase 2 kinds — skill / review / plan / command / budget

export function extractAll(session: ParsedSession, opts: ExtractorOptions = {}): Occurrence[] {
  overbudgetThreshold = opts.turnOverbudgetUsd ?? DEFAULT_TURN_OVERBUDGET_USD;
  const out: Occurrence[] = [];
  for (const kind of FINGERPRINT_KINDS) out.push(...EXTRACTORS[kind](session));
  return out;
}
