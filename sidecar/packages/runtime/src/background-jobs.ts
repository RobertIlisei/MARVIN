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

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stepDownEffort } from "./effort";
import { marvinPaths } from "./paths";
import { enqueueWakeup, fireNow, MAX_CHAIN_DEPTH, type WakeupRecord } from "./wakeup-scheduler";
import { readWorktreeSetupConfig } from "./worktree-setup";

/** Max concurrent background jobs per session — a rail, not a workload. */
export const MAX_JOBS_PER_SESSION = 3;
/**
 * Output kept for the completion turn: the first `HEAD_BYTES` (where a build
 * announces its failure) and the last `TAIL_BYTES` (where it announces its
 * result). Was a single 8 KB tail — which, for a `make smoke`, is Hikari
 * shutdown noise and a Postgres stack trace after `System.exit(0)`, injected
 * as ~2.2K tokens of user message per job (measured 2026-08-29); the one
 * line that mattered, `Tests run: 1663 … BUILD SUCCESS`, survived by luck.
 */
const HEAD_BYTES = 1024;
const TAIL_BYTES = 2 * 1024;

/**
 * Signals that mean the job was STOPPED, not that it finished (ADR-0038
 * follow-up). A long-running job (a dev server) never exits on its own — it
 * only ends when killed, and the dominant case is the sidecar being torn down
 * on app quit, which SIGTERMs its child jobs (this module's own contract:
 * "dies if the app quits"). Firing a "job did NOT succeed — diagnose" turn for
 * that is noise that resurfaces in the chat on every relaunch. A job that
 * finishes on its own exits with a numeric code (success OR failure) and still
 * earns a turn; a genuine crash (SIGSEGV / SIGABRT / SIGBUS / SIGFPE) is NOT in
 * this set, so real crashes still notify.
 */
const STOP_SIGNALS = new Set<NodeJS.Signals>([
  "SIGTERM",
  "SIGINT",
  "SIGHUP",
  "SIGKILL",
]);

/**
 * A stop signal is only "the app quit" if the sidecar is gone shortly after.
 * 2026-09-29: under memory pressure macOS killed test JVMs while MARVIN kept
 * running, and a tab waited for a completion that the STOP_SIGNALS guard had
 * swallowed. So a stopped job stays in the on-disk ledger, and if the sidecar
 * is still alive after this grace the kill came from outside: tell the tab.
 * If the sidecar died, the next boot finds the ledger entry instead.
 */
export const STOPPED_JOB_GRACE_MS = 5_000;
let stoppedGraceMs = STOPPED_JOB_GRACE_MS;
const stopTimers = new Set<ReturnType<typeof setTimeout>>();
/** Test-only: shorten the grace. */
export function __setStoppedGraceForTests(ms: number | null): void {
  stoppedGraceMs = ms ?? STOPPED_JOB_GRACE_MS;
}

/** Interrupted jobs older than this are not reported at boot (a dev server
 *  left running for a day is not news). Matches the job-done deferral window. */
export const INTERRUPTED_JOB_REPORT_WINDOW_MS = 6 * 60 * 60 * 1000;

// ── On-disk ledger of running jobs ─────────────────────────────────────
// The in-memory map dies with the sidecar. Before this ledger, a restart or
// crash while a job ran meant the job's completion was never reported and the
// tab sat idle until a human noticed (measured 2026-09-29: jobs whose output
// was complete, with no completion turn, after sidecar restarts; and every
// running job at the 09:50 machine crash).
interface PersistedJob {
  id: string;
  command: string;
  reason: string;
  pid: number;
  startedAt: string;
  ctx: BackgroundJobContext;
}
let jobsFileOverride: string | null = null;
/** Test-only: point the ledger at a temp file. */
export function __setJobsFileForTests(path: string | null): void {
  jobsFileOverride = path;
}
function jobsFile(): string {
  return jobsFileOverride ?? marvinPaths.backgroundJobsFile();
}
function readLedger(): PersistedJob[] {
  const path = jobsFile();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { jobs?: PersistedJob[] };
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}
function writeLedger(jobs: PersistedJob[]): void {
  try {
    const path = jobsFile();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ jobs }, null, 2), "utf-8");
  } catch {
    /* the ledger is a recovery aid; never fail a job on it */
  }
}
function ledgerAdd(rec: JobRecord): void {
  const { id, command, reason, pid, startedAt, ctx } = rec;
  writeLedger([...readLedger().filter((j) => j.id !== id), { id, command, reason, pid, startedAt, ctx }]);
}
function ledgerRemove(id: string): void {
  const jobs = readLedger();
  const next = jobs.filter((j) => j.id !== id);
  if (next.length !== jobs.length) writeLedger(next);
}

/** Per-turn identity + config the completion turn inherits — same shape
 *  as the wakeup tool context (no capability elevation). */
export interface BackgroundJobContext {
  marvinSessionId: string;
  projectId: string;
  /** The checkout the job runs in (a session worktree or the project root). */
  cwd: string;
  /** ADR-0107 — project root; optional so persisted pre-0107 jobs keep parsing. */
  workDir?: string | undefined;
  model: string;
  advisorModel: string | null;
  personality: "marvin" | "neutral" | "ultron";
  permissionStrategy: "auto" | "gated" | "full";
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
  /** First HEAD_BYTES of output, frozen once full. */
  head: string;
  /** Total output bytes seen — decides whether head + tail overlap. */
  bytesSeen: number;
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
      env: jobEnv(ctx),
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
    head: "",
    bytesSeen: 0,
    cancelled: false,
    ctx,
  };
  const appendOutput = (buf: Buffer) => {
    const chunk = buf.toString("utf-8");
    rec.bytesSeen += chunk.length;
    if (rec.head.length < HEAD_BYTES) rec.head = surrogateSafeHead(rec.head + chunk, HEAD_BYTES);
    // The rolling window is head + tail wide so a job that fits inside it is
    // reported whole, with no stitching.
    rec.tail = surrogateSafeTail(rec.tail + chunk, HEAD_BYTES + TAIL_BYTES);
  };
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);
  child.on("error", (err) => {
    rec.tail += `\n[spawn error] ${err.message}\n`;
  });
  child.on("exit", (code, signal) => onExit(rec, code, signal));

  state.jobs.set(rec.id, rec);
  ledgerAdd(rec);
  return { ok: true, id: rec.id, pid: rec.pid };
}

/**
 * ADR-0110 — the project's worktree `env` map, for a job in a session worktree
 * (never the shared checkout: same rule as the turn in sdk-runner). Before
 * 2026-09-29 jobs got only the sidecar's environment, so test runs started as
 * jobs kept Testcontainers reuse ON and tabs cycled each other's containers.
 * `readWorktreeSetupConfig` validates the map at the read boundary (it refuses
 * names that select code or carry MARVIN's credentials).
 */
function jobEnv(ctx: BackgroundJobContext): NodeJS.ProcessEnv {
  const inWorktree = !!ctx.workDir && resolve(ctx.cwd) !== resolve(ctx.workDir);
  if (!inWorktree || !ctx.workDir) return process.env;
  try {
    return { ...process.env, ...readWorktreeSetupConfig(ctx.workDir).env };
  } catch {
    return process.env;
  }
}

/**
 * `String.slice` counts UTF-16 units, so a cut can land between the two
 * halves of an emoji and keep one. JavaScript tolerates the lone surrogate;
 * Foundation's JSON decoder does not — on 2026-09-03 a job's excerpt carrying
 * half of U+1FA4F went into the transcript as `\ude4f`, and the native app
 * refused to hydrate the whole session ("Invalid unicode scalar value").
 * These two cutters drop the orphaned half instead of keeping it.
 */
export function surrogateSafeHead(s: string, maxUnits: number): string {
  const cut = s.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
export function surrogateSafeTail(s: string, maxUnits: number): string {
  const cut = s.slice(-maxUnits);
  const first = cut.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? cut.slice(1) : cut;
}

/** Whole output when it fit the window; otherwise head + elision + tail. */
function outputExcerpt(rec: JobRecord): string {
  if (rec.bytesSeen <= HEAD_BYTES + TAIL_BYTES) return rec.tail;
  const tail = surrogateSafeTail(rec.tail, TAIL_BYTES);
  const elided = rec.bytesSeen - rec.head.length - tail.length;
  return `${rec.head}\n…[${elided} bytes elided]…\n${tail}`;
}

function onExit(rec: JobRecord, code: number | null, signal: NodeJS.Signals | null): void {
  state.jobs.delete(rec.id);
  // A user-cancelled job doesn't earn a "diagnose the failure" turn.
  if (rec.cancelled) {
    ledgerRemove(rec.id);
    return;
  }
  // Nor, immediately, does a job STOPPED by a shutdown-shaped signal — usually
  // the sidecar being SIGTERM'd on app quit, which kills its child jobs; firing
  // then resurfaced a spurious "did NOT succeed" turn on every relaunch
  // (ADR-0038 follow-up). But the ledger entry stays: if the sidecar is still
  // running after the grace, the kill came from outside and the tab is told;
  // if it isn't, the next boot reports the job as interrupted.
  if (signal != null && STOP_SIGNALS.has(signal)) {
    const t = setTimeout(() => {
      stopTimers.delete(t);
      ledgerRemove(rec.id);
      void fireNow(stoppedJobRecord(rec, signal));
    }, stoppedGraceMs);
    t.unref?.();
    stopTimers.add(t);
    return;
  }
  ledgerRemove(rec.id);

  const failed = signal != null || (code ?? 1) !== 0;
  const status = signal ? `killed by signal ${signal}` : `exit code ${code ?? "unknown"}`;
  const tail = outputExcerpt(rec).trim() || "(no output captured)";
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
    ...(rec.ctx.workDir ? { workDir: rec.ctx.workDir } : {}),
    model: rec.ctx.model,
    advisorModel: rec.ctx.advisorModel,
    personality: rec.ctx.personality,
    permissionStrategy: rec.ctx.permissionStrategy,
    thinkingMode: rec.ctx.thinkingMode,
    ...(rec.ctx.advisorThinkingMode ? { advisorThinkingMode: rec.ctx.advisorThinkingMode } : {}),
    // Dynamic effort (see effort.ts): a job that succeeded wakes the session
    // one rung down — the follow-up is "read the result and carry on". A job
    // that failed keeps the user's ceiling; diagnosing is real work.
    ...(failed ? {} : { effort: stepDownEffort(rec.ctx.thinkingMode, rec.ctx.model) }),
    prompt,
    reason: `background job done: ${rec.reason || rec.command.slice(0, 40)}`,
    createdAt: rec.startedAt,
    fireAt: Date.now(),
    depth: rec.ctx.depth + 1,
  };
  void fireNow(record);
}

function wakeupFor(job: Pick<JobRecord, "id" | "ctx" | "startedAt">, prompt: string, reason: string): WakeupRecord {
  return {
    id: job.id,
    marvinSessionId: job.ctx.marvinSessionId,
    projectId: job.ctx.projectId,
    cwd: job.ctx.cwd,
    ...(job.ctx.workDir ? { workDir: job.ctx.workDir } : {}),
    model: job.ctx.model,
    advisorModel: job.ctx.advisorModel,
    personality: job.ctx.personality,
    permissionStrategy: job.ctx.permissionStrategy,
    thinkingMode: job.ctx.thinkingMode,
    ...(job.ctx.advisorThinkingMode ? { advisorThinkingMode: job.ctx.advisorThinkingMode } : {}),
    prompt,
    reason,
    createdAt: job.startedAt,
    fireAt: Date.now(),
    depth: job.ctx.depth + 1,
  };
}

function stoppedJobRecord(rec: JobRecord, signal: NodeJS.Signals): WakeupRecord {
  const tail = outputExcerpt(rec).trim() || "(no output captured)";
  const prompt =
    "A background job you started earlier was stopped before it finished.\n\n" +
    `Command: \`${rec.command}\`\n` +
    `Result: killed by signal ${signal} — not by you and not by a MARVIN shutdown (MARVIN kept running). ` +
    "The usual cause is the machine running out of memory, or another process killing it.\n\n" +
    "Last output:\n```\n" +
    tail +
    "\n```\n\n" +
    "It did NOT finish. Re-run it (in the foreground if it is short, or when fewer heavy jobs are running), then continue your plan.";
  return wakeupFor(rec, prompt, `background job stopped: ${rec.reason || rec.command.slice(0, 40)}`);
}

/**
 * On boot: every job still in the ledger was running when the sidecar went
 * away (a restart, an app quit, a crash). Its result is unknown — tell its
 * session so the tab doesn't wait forever. Returns what was reported.
 */
export function recoverInterruptedJobs(now: number = Date.now()): { reported: number; dropped: number } {
  const jobs = readLedger().filter((j) => !state.jobs.has(j.id));
  let reported = 0;
  let dropped = 0;
  for (const j of jobs) {
    const age = now - Date.parse(j.startedAt);
    if (!Number.isFinite(age) || age > INTERRUPTED_JOB_REPORT_WINDOW_MS) {
      dropped += 1;
      continue;
    }
    const prompt =
      "A background job you started earlier was cut off when MARVIN restarted, so its completion was never reported.\n\n" +
      `Command: \`${j.command}\`\n` +
      `Started: ${j.startedAt}\n\n` +
      "Its result is unknown: it may have finished, failed, or been killed (it may even still be running as an orphan). " +
      "Check what it was meant to produce (git log, test reports, build output), re-run it if the result isn't there, " +
      "then continue your plan.";
    enqueueWakeup({ ...wakeupFor(j, prompt, `background job interrupted: ${j.reason || j.command.slice(0, 40)}`), fireAt: now + 15_000 });
    reported += 1;
  }
  writeLedger(readLedger().filter((j) => state.jobs.has(j.id)));
  return { reported, dropped };
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
  for (const t of stopTimers) clearTimeout(t);
  stopTimers.clear();
}
