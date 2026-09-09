/**
 * Session recovery (ADR-0107) — turns a crash or restart cut off, and the
 * server-initiated way to pick them up again.
 *
 * Every turn writes `turn.started` and then exactly one terminal record
 * (`turn.completed` or `turn.error`). A transcript whose newest of those
 * three is a `turn.started` — with no live turn in the registry — was cut
 * off: the process died, or the app was restarted under it. Nothing marked
 * that before; the tab simply looked idle, and the only way back was a
 * hand-crafted API call (2026-09-08, three tabs).
 *
 * Two halves:
 *   - at boot, append an `interrupted` marker so the transcript, the meta and
 *     every watcher agree the turn ended abnormally (idempotent);
 *   - on request, rebuild a turn from the session's persisted posture and
 *     dispatch it through the WAKEUP path (`fireNow` → `startScheduledTurn`),
 *     which already yields to a live human turn, spaces machine turns, and
 *     re-resolves the session's tree at fire time.
 *
 * ADR-0072: only the TAIL of a transcript is read, never the whole file.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

import { marvinPaths } from "./paths";
import { listProjects } from "./projects";
import { appendSessionTurn, listSessions } from "./session";
import { readSessionMeta, resolveSessionCwd, type SessionMeta, type SessionPosture, updateSessionMeta, upsertSessionMeta } from "./session-meta";
import { getLiveTurn } from "./turn-registry";
import { fireNow, type WakeupRecord } from "./wakeup-scheduler";

const TAIL_BYTES = 256 * 1024;

export interface InterruptedSession {
  marvinSessionId: string;
  turnId: string;
  startedAt: string;
  /** The last thing the user asked, for the "resume?" affordance. */
  lastUserMessage: string | null;
  posture: SessionPosture | null;
  cwdPresent: boolean;
}

interface TailScan {
  newest: "turn.started" | "turn.completed" | "turn.error" | null;
  /** The newest `turn.started` line, parsed. */
  started: (Record<string, unknown> & { turnId?: string; at?: string }) | null;
  /** True when the newest terminal is already our own interrupted marker. */
  markedInterrupted: boolean;
  lastUserMessage: string | null;
}

function readTail(path: string): string {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Scan a transcript's tail for the newest turn boundary. Exported for tests. */
export function scanTail(text: string): TailScan {
  const out: TailScan = { newest: null, started: null, markedInterrupted: false, lastUserMessage: null };
  const lines = text.split("\n");
  // Walk backwards; the first (i.e. newest) boundary decides.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!line.startsWith("{")) continue;
    const isStarted = line.includes('"type":"turn.started"');
    const isCompleted = line.includes('"type":"turn.completed"');
    const isError = line.includes('"type":"turn.error"');
    const isUser = line.includes('"type":"turn.user"');
    if (!isStarted && !isCompleted && !isError && !isUser) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a truncated final line
    }
    if (isUser) {
      if (out.lastUserMessage === null && typeof parsed.message === "string") out.lastUserMessage = parsed.message.slice(0, 200);
      continue;
    }
    if (out.newest === null) {
      out.newest = isStarted ? "turn.started" : isCompleted ? "turn.completed" : "turn.error";
      if (isError && parsed.interrupted === true) out.markedInterrupted = true;
    }
    if (isStarted && out.started === null) out.started = parsed as TailScan["started"];
    if (out.newest !== null && out.started !== null && out.lastUserMessage !== null) break;
  }
  return out;
}

function postureFrom(started: Record<string, unknown> | null): SessionPosture | null {
  if (!started || typeof started.model !== "string") return null;
  return {
    model: started.model,
    advisorModel: typeof started.advisorModel === "string" ? started.advisorModel : null,
    personality: (started.personality as SessionPosture["personality"]) ?? "ultron",
    permissionStrategy: (started.permissionStrategy as SessionPosture["permissionStrategy"]) ?? "auto",
    ...(typeof started.playwrightEnabled === "boolean" ? { playwrightEnabled: started.playwrightEnabled } : {}),
    thinkingMode: typeof started.thinkingMode === "string" ? started.thinkingMode : "high",
    ...(typeof started.advisorThinkingMode === "string" ? { advisorThinkingMode: started.advisorThinkingMode } : {}),
    ...(typeof started.mode === "string" ? { mode: started.mode as SessionPosture["mode"] } : {}),
  };
}

/**
 * ADR-0107 addendum 2 — how old a cut-off turn may be and still count as
 * "interrupted". The first boot with the marker flagged transcripts whose
 * dangling `turn.started` dated from months earlier (every restart since
 * had left them that way), so the Sessions pane offered Resume on nine
 * sessions nobody would resume. Same window as the watch's recent set.
 */
export const INTERRUPTED_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** Sessions of a project whose last turn was cut off RECENTLY and is not running now. */
export function findInterruptedSessions(
  projectId: string,
  opts: { includeMarked?: boolean; maxAgeMs?: number; now?: number } = {},
): InterruptedSession[] {
  const out: InterruptedSession[] = [];
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? INTERRUPTED_MAX_AGE_MS;
  for (const s of listSessions(projectId)) {
    const live = getLiveTurn(s.sessionId);
    if (live && !live.ended) continue;
    const path = marvinPaths.sessionFile(projectId, s.sessionId);
    if (!existsSync(path)) continue;
    let scan: TailScan;
    try {
      scan = scanTail(readTail(path));
    } catch {
      continue;
    }
    const cutOff = scan.newest === "turn.started" || (scan.newest === "turn.error" && scan.markedInterrupted && opts.includeMarked === true);
    if (!cutOff || !scan.started) continue;
    const startedAtMs = typeof scan.started.at === "string" ? Date.parse(scan.started.at) : Number.NaN;
    if (!Number.isFinite(startedAtMs) || now - startedAtMs > maxAge) continue;
    const meta = readSessionMeta(projectId, s.sessionId);
    const cwdPresent = meta ? resolveSessionCwd(meta).present : true;
    out.push({
      marvinSessionId: s.sessionId,
      turnId: typeof scan.started.turnId === "string" ? scan.started.turnId : "",
      startedAt: typeof scan.started.at === "string" ? scan.started.at : "",
      lastUserMessage: scan.lastUserMessage,
      posture: meta?.posture ?? postureFrom(scan.started),
      cwdPresent,
    });
  }
  return out;
}

/**
 * At sidecar boot: stamp every cut-off transcript with an `interrupted`
 * terminal and mark its meta, so the watch feed shows "interrupted" and a
 * later scan does not report it twice. Returns how many were marked.
 */
export function markInterruptedAtBoot(now = new Date()): { marked: number } {
  let marked = 0;
  for (const project of listProjects()) {
    for (const s of findInterruptedSessions(project.id)) {
      appendSessionTurn(project.id, s.marvinSessionId, {
        type: "turn.error",
        at: now.toISOString(),
        error: "turn interrupted by a MARVIN restart",
        interrupted: true,
        code: "interrupted",
      });
      const meta = readSessionMeta(project.id, s.marvinSessionId);
      const lastTurn = { turnId: s.turnId, startedAt: s.startedAt, endedAt: now.toISOString(), outcome: "interrupted" as const };
      if (meta) {
        updateSessionMeta(project.id, s.marvinSessionId, { lastTurn });
      } else if (s.posture) {
        upsertSessionMeta(project.id, s.marvinSessionId, { workDir: project.workDir, tree: { mode: "shared" }, posture: s.posture }, { lastTurn });
      }
      marked += 1;
    }
  }
  return { marked };
}

/** The wakeup record a resume dispatches. Exported for tests. */
export function buildResumeRecord(meta: SessionMeta, opts: { prompt?: string | undefined; now?: number | undefined } = {}): WakeupRecord {
  const { cwd } = resolveSessionCwd(meta);
  const last = meta.lastTurn;
  const prompt =
    opts.prompt ??
    `Your previous turn${last ? ` (${last.turnId.slice(0, 8)}, started ${last.startedAt})` : ""} was cut off when MARVIN restarted — ` +
      `not by the user. Re-read your last plan step and the transcript's tail, check \`git status\`, and continue from where ` +
      `it stops. Do not repeat completed work and do not ask for approval the plan already granted.`;
  return {
    id: randomUUID(),
    marvinSessionId: meta.marvinSessionId,
    projectId: meta.projectId,
    cwd,
    workDir: meta.workDir,
    model: meta.posture.model,
    advisorModel: meta.posture.advisorModel,
    personality: meta.posture.personality,
    permissionStrategy: meta.posture.permissionStrategy,
    ...(meta.posture.playwrightEnabled !== undefined ? { playwrightEnabled: meta.posture.playwrightEnabled } : {}),
    thinkingMode: meta.posture.thinkingMode,
    ...(meta.posture.advisorThinkingMode ? { advisorThinkingMode: meta.posture.advisorThinkingMode } : {}),
    prompt,
    reason: "resume after restart",
    createdAt: new Date(opts.now ?? Date.now()).toISOString(),
    fireAt: opts.now ?? Date.now(),
    depth: 0,
  };
}

export type ResumeResult = { ok: true; turnDispatched: true } | { ok: false; status: number; code: string; error: string };

/** Dispatch a resume for a session. The turn announces itself on the feed. */
export async function resumeSession(projectId: string, marvinSessionId: string, opts: { prompt?: string } = {}): Promise<ResumeResult> {
  const live = getLiveTurn(marvinSessionId);
  if (live && !live.ended) return { ok: false, status: 409, code: "turn-live", error: "a turn is already running in this session" };
  const meta = readSessionMeta(projectId, marvinSessionId);
  if (!meta) return { ok: false, status: 404, code: "no-meta", error: "no session record to resume from" };
  if (!resolveSessionCwd(meta).present) {
    return { ok: false, status: 409, code: "worktree-missing", error: "the session's worktree is missing" };
  }
  await fireNow(buildResumeRecord(meta, { prompt: opts.prompt }));
  return { ok: true, turnDispatched: true };
}
