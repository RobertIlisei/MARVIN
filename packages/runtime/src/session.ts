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

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** Append one event. Guarantees the parent dir exists. Synchronous on purpose
 *  — these are tiny writes and we want ordering. */
export function appendSessionTurn(
  projectId: string,
  sessionId: string,
  turn: SessionTurn,
): void {
  const path = marvinPaths.sessionFile(projectId, sessionId);
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(turn)}\n`, "utf-8");
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
