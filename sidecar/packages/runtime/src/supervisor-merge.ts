/**
 * The standing merge authorisation's store (ADR-0134).
 *
 * The user may give a project ONE standing, expiring authorisation: finished
 * tab branches merge into one named local branch (`target`), each behind a gate
 * command the user approved. The RUNTIME performs it (`supervisor-merge-pass.ts`);
 * this module is the one place the authorisation, the supervisor's holds and the
 * pass's per-branch record are read and written.
 *
 * - **Where it lives.** `<MARVIN_DATA_DIR>/supervisor/<projectId>/merge.json` —
 *   the supervisor dir, which a tab cannot reach (`supervisor-boundary.ts`).
 *   Never the project's `.marvin/`: a repository can write that, and this file
 *   holds the user's authority to move a branch and a command the runtime runs.
 * - **Only the user's click creates it.** `approveMerge` is the only writer of
 *   `authorisation`, called by the inbox consent. `readMerge` drops an
 *   authorisation without `approvedBy: "user"`, a real `approvedAt`, an expiry
 *   inside 14 days of it and a gate within bounds — so a hand-edited or
 *   model-written file authorises nothing. A changed target, gate, timeout or
 *   hold is a NEW approval: nothing here edits an authorisation in place.
 * - **The supervisor's narrow powers** are `holdBranch` and `releaseOwnHold`.
 *   It can hold a branch and undo its own hold; a window or a gate result is
 *   never its to override, and nothing here starts a pass or merges.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { containsSecretShape } from "./session";
import { ensureSupervisorDir, supervisorDir } from "./supervisor-ledger";
import { announceProjectEvent } from "./turn-registry";

export const MERGE_MAX_EXPIRY_MS = 14 * 24 * 3600 * 1000;
export const MERGE_DEFAULT_VALID_HOURS = 7 * 24;
/** Gates take 25–55 minutes; the default leaves room, the bound stops a runaway. */
export const GATE_DEFAULT_TIMEOUT_MS = 90 * 60 * 1000;
export const GATE_MIN_TIMEOUT_MS = 60 * 1000;
export const GATE_MAX_TIMEOUT_MS = 4 * 3600 * 1000;
export const MAX_GATE_CHARS = 1000;
export const MAX_HOLDS = 20;
export const MAX_BRANCH_HOLD_REASON_CHARS = 300;
export const MAX_BRANCH_RECORDS = 60;
const MAX_REPORT_CHARS = 3000;

/** A local branch name the pass may merge into: no option-shaped, ref-syntax or path-escaping names. */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface MergeHoldRule {
  /** A gitignore-style glob over the paths the branch's diff touches. */
  pathGlob: string;
  /** Local time of the machine; `from > to` wraps midnight. */
  window: { from: string; to: string };
}

export interface MergeAuthorisation {
  target: string;
  gate: string;
  timeoutMs: number;
  holds: MergeHoldRule[];
  approvedAt: string;
  approvedBy: "user";
  expiresAt: string;
  /** The zone the windows were read in when the user approved: the card said it. */
  timeZone: string;
}

/** What the card shows and the user's click approves. Nothing here is consent. */
export interface MergeProposal {
  target: string;
  gate: string;
  timeoutMs: number;
  holds: MergeHoldRule[];
  validForHours: number;
  timeZone: string;
}

export interface BranchHold {
  branch: string;
  reason: string;
  at: string;
  by: "supervisor";
}

export type BranchStatus = "merged" | "skipped" | "failed" | "waiting" | "running" | "held";

/** What the pass did with one branch, for the workspace. The ledger carries the same facts line by line. */
export interface BranchRecord {
  branch: string;
  status: BranchStatus;
  code: string;
  reason: string;
  at: string;
  prediction?: "clean" | "conflict" | "unknown";
  gateExit?: number | null;
  commit?: string;
  /** What was (or could not be) sent to the tab: the conflict list, the failing output's tail. */
  report?: string;
  /** The report reached the tab, or was only recorded (a closed tab cannot be messaged). */
  reported?: "sent" | "recorded";
  /** After a merge: what became of the tab (ADR-0134 decision 5) — closed, already closed, or left open and why. */
  tab?: string;
}

export interface MergeRunning {
  branch: string;
  stage: "predicting" | "merging" | "gate" | "advancing";
  startedAt: string;
}

export interface MergeFile {
  version: 1;
  authorisation: MergeAuthorisation | null;
  /** How the last authorisation ended (revoked by the user, or expired), for the workspace. */
  ended: { at: string; why: "revoked" | "expired"; target: string } | null;
  holds: BranchHold[];
  branches: BranchRecord[];
  running: MergeRunning | null;
}

export const emptyMerge = (): MergeFile => ({ version: 1, authorisation: null, ended: null, holds: [], branches: [], running: null });

export function mergePath(projectId: string): string {
  return path.join(supervisorDir(projectId), "merge.json");
}

const isIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Null when `name` is a branch the authorisation may name; otherwise why not. */
export function branchNameError(name: unknown): string | null {
  if (typeof name !== "string" || !BRANCH_RE.test(name)) return "a branch name is 1–200 characters of letters, digits, '.', '_', '-' and '/'";
  if (name.includes("..") || name.endsWith("/") || name.endsWith(".lock") || name.includes("//") || name.includes("/.")) return "that is not a valid branch name";
  return null;
}

/** The gate command the runtime may be asked to run: one string, bounded, no NUL, no secret shape. Null when fine. */
export function gateCommandError(command: unknown): string | null {
  if (typeof command !== "string" || !command.trim() || command.length > MAX_GATE_CHARS || command.includes("\0")) return `the gate command is 1–${MAX_GATE_CHARS} characters`;
  if (containsSecretShape(command)) return "the command carries a secret-shaped string (ADR-0127 §6)";
  return null;
}

function readHoldRule(v: unknown): MergeHoldRule | null {
  const o = asRecord(v);
  const w = asRecord(o?.window);
  if (!o || !w) return null;
  const g = o.pathGlob;
  if (typeof g !== "string" || !g.trim() || g.length > 200 || g.includes("\0") || g.includes("..")) return null;
  if (typeof w.from !== "string" || typeof w.to !== "string" || !TIME_RE.test(w.from) || !TIME_RE.test(w.to) || w.from === w.to) return null;
  return { pathGlob: g.trim(), window: { from: w.from, to: w.to } };
}

/** The holds a proposal names, or why they are refused. */
export function holdRulesError(raw: unknown): { ok: true; holds: MergeHoldRule[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, holds: [] };
  if (!Array.isArray(raw) || raw.length > MAX_HOLDS) return { ok: false, error: `holds is a list of at most ${MAX_HOLDS} rules` };
  const holds: MergeHoldRule[] = [];
  for (const r of raw) {
    const h = readHoldRule(r);
    if (!h) return { ok: false, error: 'a hold is { pathGlob, window: { from: "HH:MM", to: "HH:MM" } } — the two times differ' };
    holds.push(h);
  }
  return { ok: true, holds };
}

/**
 * The authorisation as stored. One that is not exactly what a user's click
 * writes is not an authorisation: a file in a data dir is still a file.
 */
function readAuthorisation(raw: unknown): MergeAuthorisation | null {
  const o = asRecord(raw);
  if (!o || o.approvedBy !== "user" || !isIso(o.approvedAt) || !isIso(o.expiresAt)) return null;
  const span = Date.parse(o.expiresAt) - Date.parse(o.approvedAt);
  if (!(span > 0) || span > MERGE_MAX_EXPIRY_MS) return null;
  if (branchNameError(o.target) || gateCommandError(o.gate)) return null;
  if (typeof o.timeoutMs !== "number" || !Number.isInteger(o.timeoutMs) || o.timeoutMs < GATE_MIN_TIMEOUT_MS || o.timeoutMs > GATE_MAX_TIMEOUT_MS) return null;
  const holds = holdRulesError(o.holds ?? []);
  if (!holds.ok) return null;
  return {
    target: o.target as string,
    gate: o.gate as string,
    timeoutMs: o.timeoutMs,
    holds: holds.holds,
    approvedAt: o.approvedAt,
    approvedBy: "user",
    expiresAt: o.expiresAt,
    timeZone: typeof o.timeZone === "string" ? o.timeZone.slice(0, 80) : "",
  };
}

function readBranchRecord(v: unknown): BranchRecord | null {
  const o = asRecord(v);
  if (!o || typeof o.branch !== "string" || typeof o.code !== "string" || typeof o.reason !== "string" || !isIso(o.at)) return null;
  const status = o.status;
  if (status !== "merged" && status !== "skipped" && status !== "failed" && status !== "waiting" && status !== "running" && status !== "held") return null;
  const prediction = o.prediction === "clean" || o.prediction === "conflict" || o.prediction === "unknown" ? o.prediction : undefined;
  return {
    branch: o.branch.slice(0, 200),
    status,
    code: o.code.slice(0, 60),
    reason: o.reason.slice(0, 600),
    at: o.at,
    ...(prediction ? { prediction } : {}),
    ...(typeof o.gateExit === "number" || o.gateExit === null ? { gateExit: o.gateExit as number | null } : {}),
    ...(typeof o.commit === "string" ? { commit: o.commit.slice(0, 64) } : {}),
    ...(typeof o.report === "string" ? { report: o.report.slice(0, MAX_REPORT_CHARS) } : {}),
    ...(o.reported === "sent" || o.reported === "recorded" ? { reported: o.reported } : {}),
    ...(typeof o.tab === "string" ? { tab: o.tab.slice(0, 300) } : {}),
  };
}

/** The store, validated at the read boundary. A missing or corrupt file is an empty one. */
export function readMerge(projectId: string): MergeFile {
  const p = mergePath(projectId);
  if (!existsSync(p)) return emptyMerge();
  let raw: Record<string, unknown> | null;
  try {
    raw = asRecord(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return emptyMerge();
  }
  if (!raw) return emptyMerge();
  const ended = asRecord(raw.ended);
  const running = asRecord(raw.running);
  const holds: BranchHold[] = [];
  for (const h of Array.isArray(raw.holds) ? raw.holds : []) {
    const o = asRecord(h);
    if (o && o.by === "supervisor" && !branchNameError(o.branch) && typeof o.reason === "string" && o.reason && isIso(o.at) && holds.length < 200) {
      holds.push({ branch: o.branch as string, reason: o.reason.slice(0, MAX_BRANCH_HOLD_REASON_CHARS), at: o.at, by: "supervisor" });
    }
  }
  const branches = (Array.isArray(raw.branches) ? raw.branches : []).map(readBranchRecord).filter((r): r is BranchRecord => r !== null).slice(-MAX_BRANCH_RECORDS);
  return {
    version: 1,
    authorisation: readAuthorisation(raw.authorisation),
    ended: ended && isIso(ended.at) && (ended.why === "revoked" || ended.why === "expired") && typeof ended.target === "string" ? { at: ended.at, why: ended.why, target: ended.target.slice(0, 200) } : null,
    holds,
    branches,
    running:
      running && typeof running.branch === "string" && isIso(running.startedAt) && ["predicting", "merging", "gate", "advancing"].includes(String(running.stage))
        ? { branch: running.branch.slice(0, 200), stage: running.stage as MergeRunning["stage"], startedAt: running.startedAt }
        : null,
  };
}

function writeMerge(projectId: string, m: MergeFile, change: string): void {
  const dir = ensureSupervisorDir(projectId);
  const file = path.join(dir, "merge.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    announceProjectEvent({ event: "supervisor.merge", data: { projectId, change } });
  } catch {
    /* the file stands; only the notification is lost */
  }
}

/** Read, change, write — synchronous, so two callers in one process cannot interleave. */
export function updateMerge(projectId: string, change: string, fn: (m: MergeFile) => void): MergeFile {
  const m = readMerge(projectId);
  fn(m);
  writeMerge(projectId, m, change);
  return m;
}

/** The authorisation that holds right now — the user's, unexpired — or null. The pass asks this before every branch. */
export function activeAuthorisation(projectId: string, now = Date.now()): MergeAuthorisation | null {
  const a = readMerge(projectId).authorisation;
  return a && now < Date.parse(a.expiresAt) ? a : null;
}

// ── The user's acts ─────────────────────────────────────────────────────────

/** A proposal's fields, checked. The route and the card builder share this so the card shows only what could be approved. */
export function checkMergeProposal(raw: {
  target?: unknown;
  gate?: unknown;
  timeoutMs?: unknown;
  holds?: unknown;
  validForHours?: unknown;
}): { ok: true; proposal: Omit<MergeProposal, "timeZone"> } | { ok: false; error: string } {
  const target = typeof raw.target === "string" ? raw.target.trim() : "";
  const targetErr = branchNameError(target);
  if (targetErr) return { ok: false, error: `target: ${targetErr}` };
  // A tab's own branch is never a place to integrate into.
  if (target.startsWith("marvin/")) return { ok: false, error: "target is the integration branch — not one of MARVIN's own marvin/* branches" };
  const gate = typeof raw.gate === "string" ? raw.gate.trim() : "";
  const gateErr = gateCommandError(gate);
  if (gateErr) return { ok: false, error: gateErr };
  const timeoutMs = raw.timeoutMs === undefined ? GATE_DEFAULT_TIMEOUT_MS : raw.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < GATE_MIN_TIMEOUT_MS || timeoutMs > GATE_MAX_TIMEOUT_MS) {
    return { ok: false, error: `the gate timeout is ${GATE_MIN_TIMEOUT_MS / 1000}–${GATE_MAX_TIMEOUT_MS / 1000} seconds` };
  }
  const validForHours = raw.validForHours === undefined ? MERGE_DEFAULT_VALID_HOURS : raw.validForHours;
  if (typeof validForHours !== "number" || !Number.isInteger(validForHours) || validForHours < 1 || validForHours * 3600 * 1000 > MERGE_MAX_EXPIRY_MS) {
    return { ok: false, error: `the authorisation is valid for 1–${MERGE_MAX_EXPIRY_MS / 3600 / 1000} hours (at most 14 days)` };
  }
  const holds = holdRulesError(raw.holds);
  if (!holds.ok) return holds;
  return { ok: true, proposal: { target, gate, timeoutMs, holds: holds.holds, validForHours } };
}

/**
 * The user approved this proposal (the card's click). The ONLY writer of an
 * authorisation; `approvedBy` is set here and nowhere else. It replaces any
 * earlier one wholesale — there is no edit, so a changed target, gate, timeout
 * or hold is always a fresh approval of exactly what the card showed.
 */
export function approveMerge(projectId: string, proposal: MergeProposal, now = new Date()): { ok: true; expiresAt: string } | { ok: false; error: string } {
  const checked = checkMergeProposal(proposal);
  if (!checked.ok) return checked;
  const p = checked.proposal;
  const expiresAt = new Date(now.getTime() + p.validForHours * 3600 * 1000).toISOString();
  updateMerge(projectId, "approved", (m) => {
    m.authorisation = {
      target: p.target,
      gate: p.gate,
      timeoutMs: p.timeoutMs,
      holds: p.holds,
      approvedAt: now.toISOString(),
      approvedBy: "user",
      expiresAt,
      timeZone: String(proposal.timeZone ?? "").slice(0, 80),
    };
    m.ended = null;
  });
  return { ok: true, expiresAt };
}

/** Revoke, in one click. The pass stops before its next branch and kills an in-flight gate. */
export function revokeMerge(projectId: string, now = new Date()): boolean {
  const cur = readMerge(projectId).authorisation;
  if (!cur) return false;
  updateMerge(projectId, "revoked", (m) => {
    m.authorisation = null;
    m.ended = { at: now.toISOString(), why: "revoked", target: cur.target };
    m.running = null;
  });
  return true;
}

/** An authorisation past its expiry is recorded as ended (once), and is no authorisation. */
export function noteExpired(projectId: string, now = Date.now()): boolean {
  const cur = readMerge(projectId).authorisation;
  if (!cur || now < Date.parse(cur.expiresAt)) return false;
  updateMerge(projectId, "expired", (m) => {
    m.authorisation = null;
    m.ended = { at: new Date(now).toISOString(), why: "expired", target: cur.target };
    m.running = null;
  });
  return true;
}

/** The user lifts a supervisor's hold. */
export function releaseHoldAsUser(projectId: string, branch: string): boolean {
  let done = false;
  updateMerge(projectId, "released", (m) => {
    const before = m.holds.length;
    m.holds = m.holds.filter((h) => h.branch !== branch);
    done = m.holds.length < before;
  });
  return done;
}

// ── The supervisor's narrow powers (each ledgered by its verb) ──────────────

/** Hold one branch out of the pass, with a reason. It can hold only; it cannot start, force or approve anything. */
export function holdBranch(projectId: string, branch: string, reason: string, now = new Date()): { ok: true } | { ok: false; error: string } {
  if (branchNameError(branch)) return { ok: false, error: "that is not a branch name" };
  const m = readMerge(projectId);
  if (!m.authorisation) return { ok: false, error: "there is no merge authorisation to hold a branch under" };
  if (m.holds.some((h) => h.branch === branch)) return { ok: false, error: `"${branch}" is already held` };
  updateMerge(projectId, "held", (f) => {
    f.holds.push({ branch, reason: reason.slice(0, MAX_BRANCH_HOLD_REASON_CHARS), at: now.toISOString(), by: "supervisor" });
  });
  return { ok: true };
}

/**
 * Undo the supervisor's OWN hold. Only a hold it placed is here to release; a
 * hold window and a failed gate are data and a result, not holds, and are
 * out of its reach by construction.
 */
export function releaseOwnHold(projectId: string, branch: string): { ok: true } | { ok: false; error: string } {
  if (!readMerge(projectId).holds.some((h) => h.branch === branch && h.by === "supervisor")) return { ok: false, error: `no hold of yours on "${branch}"` };
  updateMerge(projectId, "released", (f) => {
    f.holds = f.holds.filter((h) => !(h.branch === branch && h.by === "supervisor"));
  });
  return { ok: true };
}

// ── What the pass writes (never the supervisor) ─────────────────────────────

export function recordBranch(projectId: string, rec: BranchRecord): void {
  updateMerge(projectId, "branch", (m) => {
    m.branches = [...m.branches.filter((b) => b.branch !== rec.branch), rec].slice(-MAX_BRANCH_RECORDS);
  });
}

export function setRunning(projectId: string, running: MergeRunning | null): void {
  updateMerge(projectId, "running", (m) => {
    m.running = running;
  });
}

// ── Hold windows ────────────────────────────────────────────────────────────

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Is `now` (local time) inside the window? `from` inclusive, `to` exclusive; `from > to` wraps midnight. */
export function insideWindow(w: MergeHoldRule["window"], now: Date): boolean {
  const t = now.getHours() * 60 + now.getMinutes();
  const from = minutesOf(w.from);
  const to = minutesOf(w.to);
  return from < to ? t >= from && t < to : t >= from || t < to;
}

/** The time zone this process reads local times in — what the card states. */
export const localTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
};

/**
 * The workspace's read (`GET /api/supervisor/merge`): the authorisation in
 * full — the gate command is the text the user approved — its holds, who
 * placed each branch hold and why, and what the pass did with each branch.
 */
export function mergeView(projectId: string, now = Date.now()) {
  const m = readMerge(projectId);
  const a = m.authorisation;
  const expired = !!a && now >= Date.parse(a.expiresAt);
  return {
    authorisation: a
      ? { target: a.target, gate: a.gate, timeoutSeconds: Math.round(a.timeoutMs / 1000), holds: a.holds, approvedAt: a.approvedAt, expiresAt: a.expiresAt, timeZone: a.timeZone, expired }
      : null,
    ended: m.ended,
    holds: m.holds,
    branches: [...m.branches].reverse(),
    running: m.running,
    asOf: new Date(now).toISOString(),
  };
}
