/**
 * Session persistence for MARVIN.
 *
 * Each conversation is a JSONL file under
 * `<MARVIN_DATA_DIR>/sessions/<projectId>/<sessionId>.jsonl`. One JSON object
 * per line, append-only. We never edit past turns — if the user forks the
 * conversation, we fork the file (new session id, copy-on-write).
 *
 * The stored events are a superset of what the CLI emits — we record the
 * user's original prompt as a `turn.user` event, every `ClaudeStreamEvent`
 * from the CLI (so tool calls + results are preserved), and a
 * `turn.completed` event with aggregated totals.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { ClaudeStreamEvent, TokenUsage } from "./claude-cli";
import { marvinPaths } from "./paths";

export type SessionTurn =
  | { type: "turn.user"; at: string; message: string }
  | {
      /**
       * Turn-start event recorded once per turn. Carries the model
       * routing + permission posture in effect at dispatch so the
       * transcript replay can reconstruct what was running.
       *
       * Audit finding #27 — previously the chat route logged this via
       * `as unknown as "turn.user"`; the cast is gone now that the
       * union admits the shape.
       */
      type: "turn.started";
      at: string;
      marvinSessionId: string;
      projectId: string;
      model: string;
      advisorModel: string | null;
      runtimeMode: "opus" | "advisor";
      personality: "marvin" | "neutral";
      permissionStrategy: "auto" | "gated";
      turnId: string;
    }
  | { type: "cli.event"; at: string; event: ClaudeStreamEvent | Record<string, unknown> }
  | {
      type: "turn.completed";
      at: string;
      durationMs: number | null;
      costUsd: number | null;
      tokenUsage: TokenUsage | null;
      sessionId: string | null;
    }
  | {
      type: "turn.error";
      at: string;
      error: string;
    }
  | {
      type: "confirm.request";
      at: string;
      payload: {
        turnId: string;
        toolUseId: string;
        toolName: string;
        input: Record<string, unknown>;
        reason: string;
        title?: string;
        description?: string;
        displayName?: string;
      };
    }
  | {
      type: "confirm.decision";
      at: string;
      turnId: string;
      toolUseId: string;
      decision: "allow" | "deny";
      message?: string;
    };

export interface SessionRecord {
  sessionId: string;
  projectId: string;
  /** JSONL turns in order. */
  turns: SessionTurn[];
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    // Tighten dir mode to 0700. Audit 🟠 #7: ~/.marvin/sessions/
    // contains every chat turn including tool I/O — secret-file
    // reads, `printenv` output, etc. World-readable session dirs
    // are a real exfiltration surface on shared Macs + iCloud
    // Drive sync. chmod is best-effort (some filesystems don't
    // honour mode bits; we don't fail the write if it doesn't
    // stick).
    try {
      chmodSync(path, 0o700);
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Regex patterns for known secret shapes. Best-effort, not
 * defence-in-depth — a regex pass can't reliably detect every
 * possible secret, and the right defence against persisted secrets
 * is "don't read .env-like files in MARVIN sessions." But this
 * catches the common cases (Anthropic key shapes, AWS access keys,
 * GitHub PATs, Slack tokens, JWTs) when they slip into a tool
 * input/result and would otherwise land verbatim in the JSONL.
 *
 * Each pattern replaces the secret with the same `[REDACTED]` token
 * so the structure of the payload is preserved (length will change,
 * but that's acceptable — the JSONL is for replay, not byte-exact
 * reconstruction).
 */
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic API keys (live + console)
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  // Generic Stripe-style keys
  /sk_live_[a-zA-Z0-9]{20,}/g,
  /sk_test_[a-zA-Z0-9]{20,}/g,
  /pk_live_[a-zA-Z0-9]{20,}/g,
  // GitHub personal access tokens
  /ghp_[a-zA-Z0-9]{30,}/g,
  /gho_[a-zA-Z0-9]{30,}/g,
  /ghu_[a-zA-Z0-9]{30,}/g,
  /ghs_[a-zA-Z0-9]{30,}/g,
  /ghr_[a-zA-Z0-9]{30,}/g,
  // AWS access key IDs (always 20 chars, AKIA/ASIA prefix)
  /\bA[KS]IA[A-Z0-9]{16}\b/g,
  // Slack bot/user tokens
  /xox[abprs]-[a-zA-Z0-9-]{10,}/g,
  // JWT (header.payload.signature, all base64url)
  /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]{6,}\b/g,
  // PEM private key blobs (multi-line; the BEGIN line alone is enough
  // signal that secrets follow, and downstream readers will see
  // [REDACTED] mid-block).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

function redactSecrets(s: string): string {
  let out = s;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, "[REDACTED]");
  }
  return out;
}

/**
 * Walk a JSON-shaped value and run `redactSecrets` over every
 * string field. Preserves the structure (keys, nested objects,
 * arrays) so downstream JSONL replay still understands the payload —
 * only the string leaves change.
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
}

/** Append one event. Guarantees the parent dir exists. Synchronous on purpose
 *  — these are tiny writes and we want ordering. Persisted payload is
 *  passed through a secret-pattern redactor (audit 🟠 #7) so secrets
 *  that slip into tool I/O don't end up world-readable on disk. */
export function appendSessionTurn(
  projectId: string,
  sessionId: string,
  turn: SessionTurn,
): void {
  const path = marvinPaths.sessionFile(projectId, sessionId);
  const dir = dirname(path);
  ensureDir(dir);
  const isFirstWrite = !existsSync(path);
  const redacted = redactDeep(turn) as SessionTurn;
  appendFileSync(path, `${JSON.stringify(redacted)}\n`, "utf-8");
  if (isFirstWrite) {
    // Match the directory's 0700 with the file's 0600. Same
    // best-effort contract — non-fatal if the underlying filesystem
    // doesn't honour mode bits.
    try {
      chmodSync(path, 0o600);
    } catch {
      /* non-fatal */
    }
  }
}

/** Load a session transcript from disk. Returns `null` when the file doesn't exist. */
export function loadSession(
  projectId: string,
  sessionId: string,
): SessionRecord | null {
  const path = marvinPaths.sessionFile(projectId, sessionId);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const turns: SessionTurn[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      turns.push(JSON.parse(t) as SessionTurn);
    } catch {
      // skip malformed line
    }
  }
  return { sessionId, projectId, turns };
}

/**
 * Find the last SDK session id recorded in a MARVIN session's transcript.
 *
 * Two distinct ids exist in MARVIN:
 *   - `marvinSessionId` — the JSONL filename, the transcript identity.
 *   - `sessionId` (SDK) — the Claude Agent SDK's internal session id, what
 *     `runAgent` needs as `resume` so the agent keeps its context across turns.
 *
 * The client only tracks `marvinSessionId`; the SDK's id is captured into
 * `turn.completed.sessionId` after each turn but never round-tripped to the
 * client. Without this lookup the SDK has no way to resume — every turn looks
 * like a fresh conversation to the model. /api/chat calls this to translate
 * `marvinSessionId → resume sessionId` automatically.
 *
 * Cached in-process: once a turn completes we know the SDK id and stash it,
 * so subsequent turns in the same session don't re-read the JSONL (a 123 MB
 * outlier in the wild was costing ~300 ms per /api/chat). Falls back to a
 * disk scan on cache miss (cold start, sidecar restart, unfamiliar session).
 *
 * Returns `null` for unknown sessions or transcripts whose turns all completed
 * with `sessionId: null` (rare — usually means the SDK errored before init).
 */
const sdkSessionIdCache = new Map<string, string>();
const cacheKey = (projectId: string, marvinSessionId: string) =>
  `${projectId}::${marvinSessionId}`;

export function lastSdkSessionId(
  projectId: string,
  marvinSessionId: string,
): string | null {
  const key = cacheKey(projectId, marvinSessionId);
  const cached = sdkSessionIdCache.get(key);
  if (cached) return cached;
  const path = marvinPaths.sessionFile(projectId, marvinSessionId);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n");
  // Reverse scan — the most recent turn.completed wins. Reading the whole
  // file is cheap for typical sessions; the cache shields the 100+ MB
  // outliers from re-reading on every turn.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const t = line.trim();
    if (!t) continue;
    try {
      const turn = JSON.parse(t) as SessionTurn;
      if (turn.type === "turn.completed" && turn.sessionId) {
        sdkSessionIdCache.set(key, turn.sessionId);
        return turn.sessionId;
      }
    } catch {
      // skip malformed line
    }
  }
  return null;
}

/**
 * Eagerly populate the SDK-id cache from a freshly-completed turn. /api/chat
 * calls this after `runAgent` returns so the next turn never has to scan
 * the JSONL — and so a turn that never went through `lastSdkSessionId` (e.g.
 * the very first turn of a session) still primes the cache.
 */
export function rememberSdkSessionId(
  projectId: string,
  marvinSessionId: string,
  sdkSessionId: string,
): void {
  if (!sdkSessionId) return;
  sdkSessionIdCache.set(cacheKey(projectId, marvinSessionId), sdkSessionId);
}

/** List sessions for a project, newest first (by mtime of the .jsonl). */
export function listSessions(projectId: string): Array<{
  sessionId: string;
  updatedAt: string;
  bytes: number;
}> {
  const dir = marvinPaths.sessionsDir(projectId);
  if (!existsSync(dir)) return [];
  const out: Array<{ sessionId: string; updatedAt: string; bytes: number; mtime: number }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const full = `${dir}/${name}`;
      const st = statSync(full);
      out.push({
        sessionId: name.replace(/\.jsonl$/, ""),
        updatedAt: new Date(st.mtimeMs).toISOString(),
        bytes: st.size,
        mtime: st.mtimeMs,
      });
    } catch {
      /* skip */
    }
  }
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ sessionId, updatedAt, bytes }) => ({ sessionId, updatedAt, bytes }));
}
