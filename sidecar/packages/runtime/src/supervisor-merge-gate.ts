/**
 * The standing merge's gate run (ADR-0134 decision 3).
 *
 * The gate is a command the USER approved on a card that showed it in full
 * (`merge.json`'s authorisation); it runs in the pass's scratch worktree, not
 * the user's checkout, with the project's validated `env` map (ADR-0110: the
 * names that select code — `PATH`, `DYLD_*`, `NODE_OPTIONS`, … — and MARVIN's
 * own prefixes are refused at that read boundary), bounded by the timeout the
 * user approved, and killed — the whole process group — when the authorisation
 * is revoked or expires. It keeps the tail of its output: that is what a
 * failing gate reports to the tab.
 *
 * It is the queue guard's runner (`supervisor-queue-guard.ts`) with output kept
 * and an abort signal; the guard's own tests stay as they are.
 */

import { spawn } from "node:child_process";

import { readWorktreeSetupConfig } from "./worktree-setup";

export const GATE_TAIL_CHARS = 3000;

export type GateOutcome =
  | { ok: true; tail: string }
  | { ok: false; exitCode: number | null; timedOut: boolean; aborted: boolean; detail: string; tail: string };

/** Run `command` in `cwd` (the scratch worktree) with the project's validated env map. Never throws. */
export function runGateCommand(
  projectWorkDir: string,
  cwd: string,
  command: string,
  opts: { timeoutMs: number; signal?: AbortSignal | undefined; env?: Record<string, string> | undefined },
): Promise<GateOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let tail = "";
    const keep = (b: Buffer) => {
      tail = (tail + b.toString("utf8")).slice(-GATE_TAIL_CHARS * 2);
    };
    const done = (r: GateOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const trimmed = () => tail.slice(-GATE_TAIL_CHARS).trim();
    let child: ReturnType<typeof spawn>;
    try {
      // The process's environment, then the project's validated env map — the layering a background job gets.
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
        env: { ...process.env, ...(opts.env ?? readWorktreeSetupConfig(projectWorkDir).env) },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      resolve({ ok: false, exitCode: null, timedOut: false, aborted: false, detail: (err as Error).message, tail: "" });
      return;
    }
    const killGroup = () => {
      try {
        // The whole process group: a gate that starts test containers must not outlive its timeout or its revocation.
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      killGroup();
      done({ ok: false, exitCode: null, timedOut: true, aborted: false, detail: `no exit within ${Math.round(opts.timeoutMs / 1000)}s`, tail: trimmed() });
    }, opts.timeoutMs);
    const onAbort = () => {
      killGroup();
      done({ ok: false, exitCode: null, timedOut: false, aborted: true, detail: "stopped: the authorisation ended", tail: trimmed() });
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", (err) => done({ ok: false, exitCode: null, timedOut: false, aborted: false, detail: err.message, tail: trimmed() }));
    child.on("close", (code, signal) =>
      code === 0
        ? done({ ok: true, tail: trimmed() })
        : done({ ok: false, exitCode: code, timedOut: false, aborted: false, detail: signal ? `killed by ${signal}` : `exit ${code}`, tail: trimmed() }),
    );
  });
}
