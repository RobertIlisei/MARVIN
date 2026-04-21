/**
 * `runGit(cwd, argv, opts?)` — the ONE place MARVIN shells to git.
 *
 * Contract:
 * - `execFile` only. Never `exec`, never `{ shell: true }`, never a
 *   string command.
 * - Every caller-supplied value in argv has already passed through
 *   `argv-guards.ts`. This layer adds one last statically-enforced
 *   check (`containsForbiddenFlag`) so a missed guard in a caller
 *   doesn't turn into an RCE.
 * - Default 10 s timeout. Override per call; hard cap 60 s.
 * - stdin supplied via `opts.stdin` is written then closed; `git`
 *   routes that accept user text (commit -F -) feed it here.
 * - stderr / stdout collected to in-memory buffers, capped at 2 MB
 *   each. A runaway `git log` doesn't OOM the Node process.
 *
 * See [ADR-0012](../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { containsForbiddenFlag } from "./argv-guards";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

export interface RunGitOptions {
  /** Total timeout in ms. Default 10 s, capped at 60 s. */
  timeoutMs?: number;
  /** Data written to git's stdin; stream is closed after the write. */
  stdin?: string;
  /**
   * Environment variables for the spawned git process. Defaults to
   * `process.env` with `GIT_TERMINAL_PROMPT=0` (never block on a
   * credential prompt) and `LC_ALL=C` (stable English error messages
   * for the few routes that match on stderr text).
   */
  env?: NodeJS.ProcessEnv;
}

export type RunGitOk = {
  ok: true;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RunGitErr = {
  ok: false;
  error:
    | "forbidden-flag"
    | "timeout"
    | "spawn-failed"
    | "buffer-overflow"
    | "non-zero-exit";
  detail: string;
  /** Populated on "non-zero-exit" and when stderr was captured before failure. */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Populated on "forbidden-flag". */
  flag?: string;
};

export type RunGitResult = RunGitOk | RunGitErr;

/**
 * Spawn `git` with `argv` in `cwd`. Caller is responsible for having
 * sandboxed `cwd` via `checkFsPath` and guard-whitelisted every
 * user-supplied element of `argv`.
 */
export async function runGit(
  cwd: string,
  argv: readonly string[],
  opts: RunGitOptions = {},
): Promise<RunGitResult> {
  const forbidden = containsForbiddenFlag(argv);
  if (forbidden) {
    return {
      ok: false,
      error: "forbidden-flag",
      detail: `argv contains forbidden flag: ${forbidden}`,
      flag: forbidden,
    };
  }

  const timeoutMs = clampTimeout(opts.timeoutMs);
  const env: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };

  return new Promise<RunGitResult>((resolve) => {
    let finished = false;
    const finish = (res: RunGitResult) => {
      if (finished) return;
      finished = true;
      resolve(res);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("git", [...argv], {
        cwd,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      finish({
        ok: false,
        error: "spawn-failed",
        detail: `spawn failed: ${String(e)}`,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed: "stdout" | "stderr" | null = null;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_BUFFER_BYTES) {
        overflowed ??= "stdout";
        child.kill("SIGKILL");
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_BUFFER_BYTES) {
        overflowed ??= "stderr";
        child.kill("SIGKILL");
        return;
      }
      stderrChunks.push(chunk);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        error: "timeout",
        detail: `git timed out after ${timeoutMs}ms: ${argv.join(" ")}`,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    }, timeoutMs);
    // Don't keep the event loop alive on the timer alone.
    if (typeof timer.unref === "function") timer.unref();

    child.on("error", (e) => {
      clearTimeout(timer);
      finish({
        ok: false,
        error: "spawn-failed",
        detail: `spawn error: ${String(e)}`,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (overflowed) {
        finish({
          ok: false,
          error: "buffer-overflow",
          detail: `${overflowed} exceeded ${MAX_BUFFER_BYTES}-byte cap`,
        });
        return;
      }
      if (signal === "SIGKILL" || code === null) {
        // Already resolved via timeout; this is the post-kill close.
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) {
        finish({ ok: true, stdout, stderr, exitCode: 0 });
        return;
      }
      finish({
        ok: false,
        error: "non-zero-exit",
        detail: `git exited ${code}: ${argv.join(" ")}`,
        stdout,
        stderr,
        exitCode: code,
      });
    });

    if (typeof opts.stdin === "string") {
      child.stdin.end(opts.stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

function clampTimeout(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (requested <= 0) return DEFAULT_TIMEOUT_MS;
  if (requested > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return Math.floor(requested);
}
