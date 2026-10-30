/**
 * The supervisor's ledger (ADR-0127 §6) — one append-only JSONL line per
 * proposal, act, refusal, drop, escalation, wake, rotation and user control.
 *
 * It lives under the DATA dir, never the project's `.marvin/`: `.marvin/` is
 * committed in some projects, and the ledger feeds both the supervisor's own
 * packets and the shadow agreement numbers, so a repository must not be able
 * to forge it. Written by the runtime with the auto-audit log's discipline
 * (`O_APPEND`, fsync, 0600 — `auto-audit.ts`), never by the supervisor's tools.
 *
 * Arguments are stored as a digest, not raw: a ledger line says what was
 * attempted and why, and must not become a second copy of a tab's content.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import path from "node:path";

import { getMarvinDataDir } from "./paths";

export type LedgerDecision = "propose" | "act" | "escalate" | "refuse" | "drop";
export type GroundKind = "plan" | "dod" | "adr" | "memory" | "charter" | "file";
export type GroundProvenance = "strong" | "weak" | "unresolved";

export interface LedgerGround {
  kind: GroundKind;
  ref: string;
  provenance: GroundProvenance;
}

/** How a proposal compared with what actually answered it (brief §10.5). Written once, on `confirm.resolved`. */
export interface LedgerPairing {
  /** The answer that resolved it: option labels per question (question order), or the confirm's decision. */
  actualAnswer: string[];
  answeredBy: "user" | "supervisor";
  agreement: "agree" | "disagree";
  /** The user revealed the proposal before answering (`POST /api/supervisor/reveal`). */
  proposalSeenBeforeAnswer: boolean;
}

export interface LedgerEntryInput {
  /** Stable line id (brief `ledgerId`). Generated when absent; lines written before milestone 4 have none. */
  id?: string;
  /**
   * `verb` — a supervisor proposal or act; `wake` / `rotation` — the loop;
   * `control` — the user changed state; `pairing` / `reveal` — a proposal met
   * its answer, or the user looked at it first; `heuristic-miss` — a question
   * the heuristic passed led to a human-only confirm in the same turn.
   */
  kind: "verb" | "wake" | "rotation" | "control" | "pairing" | "reveal" | "heuristic-miss";
  verb: string;
  tab: string | null;
  wakeId: string | null;
  mode?: "off" | "shadow" | "autonomous";
  decision?: LedgerDecision;
  reason: string;
  /** A stable code for `reason` (brief §10.5 `reason.code`); written from milestone 3 on. */
  reasonCode?: string;
  argsDigest?: string;
  grounds?: LedgerGround[];
  /** A nudge's plan step, `done/total@lastTodoAt` — the nudge cap counts lines that share it (§6). */
  planSignature?: string;
  /** The question heuristic's matched term, when it fired (ADR-0127 §4 — measured in shadow). */
  heuristic?: string;
  costUsd?: number;
  result?: string;
  /** The question or confirm an `answer` / `confirm` line is about (milestone 4 — pairing). */
  turnId?: string;
  toolUseId?: string;
  /** The supervisor's answer: option labels per question in question order, or `[allow|deny]`. Labels only, capped. */
  answer?: string[];
  /** `pairing` / `reveal` / `heuristic-miss` lines name the proposal line they are about. */
  proposalId?: string;
  pairing?: LedgerPairing;
  /** Why a wake was raised (milestone 4): a question, a turn that ended, or an idle tab. */
  trigger?: "question" | "turn-ended" | "idle";
}

/** Labels, not the tab's content: each capped, at most twenty. */
export function capAnswer(values: readonly string[]): string[] {
  return values.slice(0, 20).map((v) => String(v).slice(0, 200));
}

export interface LedgerEntry extends LedgerEntryInput {
  at: string;
  projectId: string;
}

/** A new line id. Exported so a verb can name its line before performing the act it records. */
export function newLedgerId(): string {
  return randomUUID();
}

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function isSafeProjectId(projectId: string): boolean {
  return PROJECT_ID_RE.test(projectId) && !projectId.includes("..");
}

/** `<MARVIN_DATA_DIR>/supervisor` — the token, and one directory per project. */
export function supervisorRoot(): string {
  return path.join(getMarvinDataDir(), "supervisor");
}

/** `<MARVIN_DATA_DIR>/supervisor/<projectId>`. Throws on a path-shaped id. */
export function supervisorDir(projectId: string): string {
  if (!isSafeProjectId(projectId)) throw new Error(`invalid projectId: ${JSON.stringify(projectId)}`);
  return path.join(supervisorRoot(), projectId);
}

function ensurePrivateDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* non-fatal */
  }
  return dir;
}

export function ensureSupervisorRoot(): string {
  return ensurePrivateDir(supervisorRoot());
}

export function ensureSupervisorDir(projectId: string): string {
  ensureSupervisorRoot();
  return ensurePrivateDir(supervisorDir(projectId));
}

export function ledgerPath(projectId: string): string {
  return path.join(supervisorDir(projectId), "ledger.jsonl");
}

/** Stable digest of a verb's arguments: key order does not change it. */
export function digestArgs(args: unknown): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex").slice(0, 16);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export function appendLedgerEntry(projectId: string, input: LedgerEntryInput): LedgerEntry {
  ensureSupervisorDir(projectId);
  const entry: LedgerEntry = { at: new Date().toISOString(), projectId, ...input, id: input.id ?? newLedgerId() };
  const fd = openSync(ledgerPath(projectId), "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return entry;
}

/**
 * The parsed file, keyed on its size and mtime. Milestone 4 reads the ledger
 * from the polled watch route and on every `confirm.resolved`; an append-only
 * file only grows, so an unchanged (size, mtime) is an unchanged ledger.
 */
const parsedCache = new Map<string, { size: number; mtimeMs: number; entries: LedgerEntry[] }>();

function parseLedgerFile(p: string): LedgerEntry[] {
  const st = statSync(p);
  const hit = parsedCache.get(p);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.entries;
  const entries: LedgerEntry[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      /* torn final line — the next append starts a fresh one */
    }
  }
  parsedCache.set(p, { size: st.size, mtimeMs: st.mtimeMs, entries });
  return entries;
}

/** Ledger entries, oldest first; `limit` keeps the newest N. A torn line is skipped. Always a fresh array. */
export function readLedger(projectId: string, opts: { limit?: number; tab?: string } = {}): LedgerEntry[] {
  const p = ledgerPath(projectId);
  if (!existsSync(p)) return [];
  const all = parseLedgerFile(p);
  const out = opts.tab !== undefined ? all.filter((e) => e.tab === opts.tab) : all.slice();
  return opts.limit !== undefined ? out.slice(-opts.limit) : out;
}
