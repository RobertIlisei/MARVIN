/**
 * Claude CLI runtime — spawns `claude -p` for a single turn and streams the
 * response as NDJSON events.
 *
 * MARVIN runs one Claude session per (project, sessionId) — no multi-agent
 * dispatch, no tool-loop orchestration layer. The CLI itself drives its
 * tool loop; we just pass messages in and stream events out.
 */

import { spawn } from "child_process";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { buildSubprocessEnv } from "./auth";

/* ── CLI binary discovery ──────────────────────────────────────────────── */

const COMMON_CLAUDE_PATHS = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  `${process.env.HOME}/.local/bin/claude`,
  `${process.env.HOME}/.claude/local/claude`,
];

let cachedBinary: string | null = null;

export function discoverClaudeBinary(): string {
  if (cachedBinary) return cachedBinary;
  const override = process.env.MARVIN_CLAUDE_BIN?.trim();
  if (override && existsSync(override)) {
    cachedBinary = override;
    return override;
  }
  for (const p of COMMON_CLAUDE_PATHS) {
    if (existsSync(p)) {
      cachedBinary = p;
      return p;
    }
  }
  try {
    const which = execSync("command -v claude", { encoding: "utf-8" }).trim();
    if (which && existsSync(which)) {
      cachedBinary = which;
      return which;
    }
  } catch {
    // fall through
  }
  throw new Error(
    "Claude CLI binary not found. Install it (https://docs.claude.com/en/docs/claude-code) or set MARVIN_CLAUDE_BIN.",
  );
}

/* ── Model + timeout ───────────────────────────────────────────────────── */

export function defaultModel(): string {
  return (
    process.env.MARVIN_MODEL?.trim() ||
    // MARVIN defaults to Opus 4.7. The pair-programming loop is sequential code
    // work, which is the regime where Opus pulls furthest ahead of Sonnet/Haiku.
    // Multi-agent / smaller-executor strategies (Advisor Strategy, subagent
    // delegation) are layered on top when helpful — the user-facing partner
    // stays top-tier.
    "claude-opus-4-7"
  );
}

export function timeoutMs(): number {
  const raw = process.env.MARVIN_TIMEOUT_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 900_000);
  }
  return 600_000; // 10 min — long enough for real code work.
}

/* ── Event types ───────────────────────────────────────────────────────── */

/** One NDJSON line from `claude -p --output-format stream-json`. */
export type ClaudeStreamEvent =
  | { type: "system"; subtype?: string; session_id?: string; [k: string]: unknown }
  | { type: "assistant"; message: AssistantMessage; session_id?: string }
  | { type: "user"; message: UserMessage; session_id?: string }
  | { type: "result"; subtype?: string; session_id?: string; total_cost_usd?: number; usage?: TokenUsage; is_error?: boolean; result?: string; duration_ms?: number; [k: string]: unknown };

export interface AssistantMessage {
  id?: string;
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id?: string; name: string; input: unknown }
  >;
  stop_reason?: string | null;
  usage?: TokenUsage;
}

export interface UserMessage {
  role: "user";
  content: Array<
    | { type: "tool_result"; tool_use_id?: string; content: string; is_error?: boolean }
  >;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ClaudeCliResult {
  ok: boolean;
  exitCode: number | null;
  /** The session id the CLI returned (use to resume). */
  sessionId: string | null;
  /** Raw result text from the final `{"type":"result"}` event. */
  text: string;
  /** Total duration as reported by the CLI. */
  durationMs: number | null;
  /** Cost in USD (CLI's own accounting). */
  costUsd: number | null;
  tokenUsage: TokenUsage | null;
  /** If non-null, the process failed — stderr or error message. */
  error: string | null;
}

/* ── Core: stream + collect ────────────────────────────────────────────── */

export interface RunClaudeCliParams {
  /** The user's message to send. */
  message: string;
  /** Working directory for the CLI subprocess — the active project. */
  cwd: string;
  /** Previous session id; when provided, `--resume sessionId` is used. */
  sessionId?: string;
  /** Override model (else MARVIN_MODEL env or sensible default). */
  model?: string;
  /** Extra text appended to Claude Code's default system prompt. */
  appendSystemPrompt?: string;
  /**
   * Callback invoked for each streamed NDJSON event. Non-blocking;
   * exceptions are swallowed so a bad consumer can't wedge the CLI.
   */
  onEvent?: (event: ClaudeStreamEvent) => void;
  /**
   * Abort signal — when triggered, the CLI subprocess is sent SIGTERM.
   * Useful for user-initiated cancellation from the UI.
   */
  signal?: AbortSignal;
}

/**
 * Spawn `claude -p` with `--output-format stream-json`, stream each NDJSON
 * line through `onEvent`, and resolve with a summary result.
 */
export function runClaudeCli(params: RunClaudeCliParams): Promise<ClaudeCliResult> {
  const {
    message,
    cwd,
    sessionId,
    model = defaultModel(),
    appendSystemPrompt,
    onEvent,
    signal,
  } = params;

  const binary = discoverClaudeBinary();
  const args = [
    "-p",
    message,
    "--output-format",
    "stream-json",
    "--verbose", // Required by Claude CLI when using stream-json output format
    "--model",
    model,
    ...(sessionId ? ["--resume", sessionId] : []),
    ...(appendSystemPrompt?.trim()
      ? ["--append-system-prompt", appendSystemPrompt.trim()]
      : []),
    "--setting-sources",
    "user",
    "--dangerously-skip-permissions",
  ];

  return new Promise<ClaudeCliResult>((resolve) => {
    const child = spawn(binary, args, {
      cwd: cwd.trim() || undefined,
      env: buildSubprocessEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let capturedSessionId: string | null = sessionId ?? null;
    let finalText = "";
    let finalDurationMs: number | null = null;
    let finalCostUsd: number | null = null;
    let finalTokenUsage: TokenUsage | null = null;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, timeoutMs());

    const onAbort = () => {
      killed = true;
      child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf-8");
      // Parse complete lines (NDJSON).
      let idx: number;
      while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!line) continue;
        let ev: ClaudeStreamEvent;
        try {
          ev = JSON.parse(line) as ClaudeStreamEvent;
        } catch {
          // Not JSON — skip (the CLI sometimes emits a banner line before streaming).
          continue;
        }
        if (ev.session_id && typeof ev.session_id === "string") {
          capturedSessionId = ev.session_id;
        }
        if (ev.type === "result") {
          if (typeof ev.result === "string") finalText = ev.result;
          if (typeof ev.duration_ms === "number") finalDurationMs = ev.duration_ms;
          if (typeof ev.total_cost_usd === "number") finalCostUsd = ev.total_cost_usd;
          if (ev.usage) finalTokenUsage = ev.usage;
        }
        if (onEvent) {
          try {
            onEvent(ev);
          } catch {
            /* never let a bad consumer wedge the stream */
          }
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        ok: false,
        exitCode: null,
        sessionId: capturedSessionId,
        text: finalText,
        durationMs: finalDurationMs,
        costUsd: finalCostUsd,
        tokenUsage: finalTokenUsage,
        error: `Failed to spawn Claude CLI: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);

      // SIGTERM (code 143) counts as success when we captured a `result` event.
      // The CLI sometimes ships the final event right before the timeout fires.
      let ok = code === 0;
      if (!ok && code === 143 && finalText && !killed) ok = true;

      resolve({
        ok,
        exitCode: code,
        sessionId: capturedSessionId,
        text: finalText,
        durationMs: finalDurationMs,
        costUsd: finalCostUsd,
        tokenUsage: finalTokenUsage,
        error: ok
          ? null
          : (stderrBuffer.trim() || `Claude CLI exited with code ${code}`).slice(0, 4000),
      });
    });
  });
}
