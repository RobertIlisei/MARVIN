/**
 * Keep the Mac awake while a turn is live (ADR-0120).
 *
 * Measured 2026-09-27 on a real 20-hour session: 51 of 51 silent gaps of
 * 5–18 minutes matched a macOS `Sleep` at the gap's start and a `DarkWake`
 * at its end, to the second (`pmset -g log`). The machine's AC profile had
 * `sleep 1`: one idle minute with no power assertion and it slept; Power Nap
 * woke it for ~45 s every quarter hour, the SDK saw a dead stream
 * (`api_retry`, no HTTP status), got a minute of work done, and the machine
 * slept again. About 11 of the 20 hours were spent asleep, and an advisor
 * consult "took" 2 h 43 min.
 *
 * The turn registry knows exactly when work is in flight, so this holds one
 * `PreventUserIdleSystemSleep` assertion — `caffeinate -i` — from the first
 * live turn to the last one's end, and never outside a turn. `-w <sidecar
 * pid>` makes the assertion die with the sidecar if the sidecar dies first;
 * a normal end kills it explicitly. Display sleep is untouched: `-i` is
 * idle *system* sleep only. Darwin only; `MARVIN_KEEP_AWAKE=0` turns it off.
 *
 * Reference-counted rather than per-turn: several tabs run turns at once
 * (ADR-0107), and one assertion covers all of them.
 */
import { type ChildProcess, spawn } from "node:child_process";

export interface KeepAwakeDeps {
  platform: NodeJS.Platform;
  spawn: typeof spawn;
  ownPid: number;
  env: NodeJS.ProcessEnv;
}

const defaultDeps: KeepAwakeDeps = {
  platform: process.platform,
  spawn,
  ownPid: process.pid,
  env: process.env,
};

let deps: KeepAwakeDeps = defaultDeps;
let liveTurns = 0;
let child: ChildProcess | null = null;

function log(kind: string, extra: Record<string, unknown> = {}): void {
  try {
    console.info("[marvin.telemetry] " + JSON.stringify({ kind, ...extra, at: new Date().toISOString() }));
  } catch {
    /* telemetry never breaks a turn */
  }
}

function enabled(): boolean {
  if (deps.platform !== "darwin") return false;
  const raw = deps.env.MARVIN_KEEP_AWAKE;
  return !(raw === "0" || raw === "false" || raw === "off");
}

function start(): void {
  if (child || !enabled()) return;
  try {
    const proc = deps.spawn("caffeinate", ["-i", "-w", String(deps.ownPid)], {
      stdio: "ignore",
      detached: false,
    });
    proc.unref?.();
    proc.on("exit", (code, signal) => {
      if (child === proc) child = null;
      // Only a caffeinate that quit on its own is worth a line; the stop
      // path logs its own.
      if (liveTurns > 0) log("keepawake.exited", { code, signal, liveTurns });
    });
    proc.on("error", (err) => {
      if (child === proc) child = null;
      log("keepawake.error", { error: (err as Error).message });
    });
    child = proc;
    log("keepawake.start", { pid: proc.pid ?? null });
  } catch (err) {
    child = null;
    log("keepawake.error", { error: (err as Error)?.message ?? String(err) });
  }
}

function stop(): void {
  const proc = child;
  child = null;
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  log("keepawake.stop", { pid: proc.pid ?? null });
}

/** A turn became live. The first one raises the assertion. */
export function noteTurnStarted(): void {
  liveTurns += 1;
  if (liveTurns === 1) start();
}

/** A turn ended (completed, errored, cancelled or evicted). The last one releases it. */
export function noteTurnEnded(): void {
  if (liveTurns === 0) return;
  liveTurns -= 1;
  if (liveTurns === 0) stop();
}

/** Test seam: inject platform / spawn / env; `null` restores the defaults and resets state. */
export function __setKeepAwakeDepsForTests(next: Partial<KeepAwakeDeps> | null): void {
  stop();
  liveTurns = 0;
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}

/** Test seam: current state. */
export function __keepAwakeStateForTests(): { liveTurns: number; holding: boolean } {
  return { liveTurns, holding: child !== null };
}
