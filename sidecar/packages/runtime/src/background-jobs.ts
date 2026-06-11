/**
 * Background jobs with event-based completion wakeups (ADR-0038).
 *
 * MARVIN used to narrate "I started the build in the background, I'll be
 * notified when it's done" — but the only wakeup type was time-based
 * (ADR-0031), nothing watched the process, and shell-level backgrounding
 * (`cmd &`, `nohup`) slipped past the ADR-0032 deny. So the job ran
 * orphaned and MARVIN forgot. This is the missing piece: a tracked child
 * process whose EXIT fires a real follow-up turn — the same mechanism this
 * very harness uses to re-invoke an agent when its background task ends.
 *
 * The job is a child of the long-lived sidecar (not detached): it outlives
 * the turn that started it, but dies if the app quits (acceptable — the
 * user quit). On exit we build a {@link WakeupRecord} and reuse the shared
 * wakeup fire handler ({@link fireNow}) — an EVENT-triggered wakeup instead
 * of a clock-triggered one. Same turn-dispatch path, same posture
 * inheritance, same chain-depth guard against runaway.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import { MAX_CHAIN_DEPTH, fireNow, type WakeupRecord } from "./wakeup-scheduler";

/** Max concurrent background jobs per session — a rail, not a workload. */
export const MAX_JOBS_PER_SESSION = 3;
/** Output tail kept in memory for the completion turn (bytes). */
const TAIL_BYTES = 8 * 1024;

/** Per-turn identity + config the completion turn inherits — same shape
 *  as the wakeup tool context (no capability elevation). */
export interface BackgroundJobContext {
  marvinSessionId: string;
  projectId: string;
  cwd: string;
  model: string;
  advisorModel: string | null;
  personality: "marvin" | "neutral";
  permissionStrategy: "auto" | "gated";
  thinkingMode: string;
  advisorThinkingMode?: string | undefined;
  /** Depth of the turn starting the job (chain-depth guard). */
  depth: number;
}

interface JobRecord {
  id: string;
  command: string;
  reason: string;
  pid: number;
  startedAt: string;
  child: ChildProcess;
  tail: string;
  /** Set when the user cancels — suppresses the completion turn. */
  cancelled: boolean;
  ctx: BackgroundJobContext;
}

// GLOBAL singleton for the same standalone-bundle reason as the wakeup
// scheduler: instrumentation.ts and the route chunk can get separate module
// copies; the running-jobs map must be shared so a job started on the route
// path and the fire handler wired there land on one object.
interface JobsState {
  jobs: Map<string, JobRecord>;
}
const STATE_KEY = "__marvinBackgroundJobsState__";
const g = globalThis as unknown as Record<string, JobsState | undefined>;
const state: JobsState = g[STATE_KEY] ?? (g[STATE_KEY] = { jobs: new Map() });

export type StartJobResult =
  | { ok: true; id: string; pid: number }
  | { ok: false; error: string };

export function startBackgroundJob(input: {
  command: string;
  reason: string;
  ctx: BackgroundJobContext;
}): StartJobResult {
  const { command, reason, ctx } = input;
  if (!command.trim()) return { ok: false, error: "command is empty" };

  const nextDepth = ctx.depth + 1;
  if (nextDepth > MAX_CHAIN_DEPTH) {
    return {
      ok: false,
      error: `job chain depth ${nextDepth} exceeds the cap of ${MAX_CHAIN_DEPTH} — refusing to start another background job from a job-completion turn.`,
    };
  }
  const running = [...state.jobs.values()].filter(
    (j) => j.ctx.marvinSessionId === ctx.marvinSessionId,
  );
  if (running.length >= MAX_JOBS_PER_SESSION) {
    return {
      ok: false,
      error: `this session already has ${running.length} background jobs running (cap ${MAX_JOBS_PER_SESSION}); wait for one to finish or cancel it.`,
    };
  }

  let child: ChildProcess;
  try {
    child = spawn("/bin/bash", ["-lc", command], {
      cwd: ctx.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return { ok: false, error: `spawn failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const rec: JobRecord = {
    id: randomUUID(),
    command,
    reason,
    pid: child.pid ?? -1,
    startedAt: new Date().toISOString(),
    child,
    tail: "",
    cancelled: false,
    ctx,
  };
  const appendTail = (buf: Buffer) => {
    rec.tail = (rec.tail + buf.toString("utf-8")).slice(-TAIL_BYTES);
  };
  child.stdout?.on("data", appendTail);
  child.stderr?.on("data", appendTail);
  child.on("error", (err) => {
    rec.tail += `\n[spawn error] ${err.message}\n`;
  });
  child.on("exit", (code, signal) => onExit(rec, code, signal));

  state.jobs.set(rec.id, rec);
  return { ok: true, id: rec.id, pid: rec.pid };
}

function onExit(rec: JobRecord, code: number | null, signal: NodeJS.Signals | null): void {
  state.jobs.delete(rec.id);
  // A user-cancelled job doesn't earn a "diagnose the failure" turn.
  if (rec.cancelled) return;

  const failed = signal != null || (code ?? 1) !== 0;
  const status = signal ? `killed by signal ${signal}` : `exit code ${code ?? "unknown"}`;
  const tail = rec.tail.trim() || "(no output captured)";
  const prompt =
    "A background job you started earlier has finished.\n\n" +
    `Command: \`${rec.command}\`\n` +
    `Result: ${status}\n\n` +
    "Last output:\n```\n" +
    tail +
    "\n```\n\n" +
    (failed
      ? "It did NOT succeed — read the output, diagnose the cause, and fix it or report clearly to the user."
      : "It succeeded — continue the work that depended on it, or report completion to the user.");

  const record: WakeupRecord = {
    id: rec.id,
    marvinSessionId: rec.ctx.marvinSessionId,
    projectId: rec.ctx.projectId,
    cwd: rec.ctx.cwd,
    model: rec.ctx.model,
    advisorModel: rec.ctx.advisorModel,
    personality: rec.ctx.personality,
    permissionStrategy: rec.ctx.permissionStrategy,
    thinkingMode: rec.ctx.thinkingMode,
    ...(rec.ctx.advisorThinkingMode ? { advisorThinkingMode: rec.ctx.advisorThinkingMode } : {}),
    prompt,
    reason: `background job done: ${rec.reason || rec.command.slice(0, 40)}`,
    createdAt: rec.startedAt,
    fireAt: Date.now(),
    depth: rec.ctx.depth + 1,
  };
  void fireNow(record);
}

export interface BackgroundJobSummary {
  id: string;
  command: string;
  reason: string;
  pid: number;
  startedAt: string;
}

export function listBackgroundJobs(marvinSessionId?: string): BackgroundJobSummary[] {
  return [...state.jobs.values()]
    .filter((j) => !marvinSessionId || j.ctx.marvinSessionId === marvinSessionId)
    .map((j) => ({
      id: j.id,
      command: j.command,
      reason: j.reason,
      pid: j.pid,
      startedAt: j.startedAt,
    }));
}

/** Cancel a running job. SIGTERM, then SIGKILL if stubborn. No completion
 *  turn fires (the user asked for it to stop). */
export function cancelBackgroundJob(id: string): boolean {
  const rec = state.jobs.get(id);
  if (!rec) return false;
  rec.cancelled = true;
  try {
    rec.child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      if (!rec.child.killed) rec.child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }, 2000).unref?.();
  return true;
}

/** Test-only: kill + clear all jobs. Marks each cancelled first so the
 *  SIGKILL'd exit doesn't fire a completion turn during teardown. */
export function __resetBackgroundJobsForTests(): void {
  for (const j of state.jobs.values()) {
    j.cancelled = true;
    try {
      j.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  state.jobs.clear();
}
