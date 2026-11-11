/**
 * The queue's guard command (ADR-0133 decision 1): a command the USER approved
 * on a card that showed it in full, run before each queued tab opens. A
 * non-zero exit — or a timeout, or a failure to start — holds the queue.
 *
 * Why it is not in `.marvin/worktree.json`: that file is written by whoever
 * wrote the repository, and a command the runtime executes cannot be made safe
 * by validating it — cloning a hostile repository would run its code
 * (`REVIEW.md`, the project-controlled-config rule). So the command lives in
 * the supervisor dir with the queue (`readQueue().guard`) and this module never
 * reads a command from any file in the project.
 *
 * What it does take from the project is the `env` map (ADR-0110), through the
 * same validated reader every turn uses, so the guard sees the variables the
 * project's own commands see — with the names that select code (`PATH`,
 * `DYLD_*`, `NODE_OPTIONS`, …) and MARVIN's own prefixes already refused there.
 */

import { spawn } from "node:child_process";

import { readWorktreeSetupConfig } from "./worktree-setup";

export const GUARD_TIMEOUT_MS = 30_000;

export type GuardOutcome = { ok: true } | { ok: false; exitCode: number | null; timedOut: boolean; detail: string };

/** Run `command` in the project root with the validated env map, bounded by a timeout. Never throws. */
export function runGuardCommand(workDir: string, command: string, opts: { timeoutMs?: number } = {}): Promise<GuardOutcome> {
  const timeoutMs = opts.timeoutMs ?? GUARD_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: GuardOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // The same layering a background job gets: the process's environment, then the project's validated env map.
      child = spawn("/bin/sh", ["-c", command], { cwd: workDir, env: { ...process.env, ...readWorktreeSetupConfig(workDir).env }, stdio: "ignore", detached: true });
    } catch (err) {
      resolve({ ok: false, exitCode: null, timedOut: false, detail: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      try {
        // The whole process group: a guard that ssh-es somewhere must not outlive its timeout.
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      done({ ok: false, exitCode: null, timedOut: true, detail: `no answer within ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.on("error", (err) => done({ ok: false, exitCode: null, timedOut: false, detail: err.message }));
    child.on("close", (code, signal) => (code === 0 ? done({ ok: true }) : done({ ok: false, exitCode: code, timedOut: false, detail: signal ? `killed by ${signal}` : `exit ${code}` })));
  });
}
