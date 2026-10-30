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

import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
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

export interface LedgerEntryInput {
  /** `verb` — a supervisor proposal or act; `wake` / `rotation` — the loop; `control` — the user changed state. */
  kind: "verb" | "wake" | "rotation" | "control";
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
}

export interface LedgerEntry extends LedgerEntryInput {
  at: string;
  projectId: string;
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
  const entry: LedgerEntry = { at: new Date().toISOString(), projectId, ...input };
  const fd = openSync(ledgerPath(projectId), "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return entry;
}

/** Ledger entries, oldest first; `limit` keeps the newest N. A torn line is skipped. */
export function readLedger(projectId: string, opts: { limit?: number; tab?: string } = {}): LedgerEntry[] {
  const p = ledgerPath(projectId);
  if (!existsSync(p)) return [];
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      if (opts.tab !== undefined && e.tab !== opts.tab) continue;
      out.push(e);
    } catch {
      /* torn final line — the next append starts a fresh one */
    }
  }
  return opts.limit !== undefined ? out.slice(-opts.limit) : out;
}
