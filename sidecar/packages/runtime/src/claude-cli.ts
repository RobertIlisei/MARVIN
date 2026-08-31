/**
 * Claude CLI runtime — spawns `claude -p` for a single turn and streams the
 * response as NDJSON events.
 *
 * MARVIN runs one Claude session per (project, sessionId) — no multi-agent
 * dispatch, no tool-loop orchestration layer. The CLI itself drives its
 * tool loop; we just pass messages in and stream events out.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { buildSubprocessEnv } from "./auth";
import { ensureProviderModelId, fallbackNewestOfTier } from "./models";

/* ── CLI binary discovery ──────────────────────────────────────────────── */

const COMMON_CLAUDE_PATHS = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  `${process.env.HOME}/.local/bin/claude`,
  `${process.env.HOME}/.claude/local/claude`,
];

let cachedBinary: string | null = null;

/** `2.1.251 (Claude Code)` → `[2, 1, 251]`; null when unreadable. */
export function claudeCliVersion(bin: string): number[] | null {
  try {
    const out = execSync(`${JSON.stringify(bin)} --version`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    return null;
  }
}

function newer(a: number[] | null, b: number[] | null): boolean {
  if (!a) return false;
  if (!b) return true;
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Find the Claude CLI — the NEWEST one installed, not the first one found.
 *
 * This used to return the first existing path in `COMMON_CLAUDE_PATHS`,
 * which put `/opt/homebrew/bin/claude` ahead of everything else. On a
 * machine with both, MARVIN ran **2.1.92** while the user's own shell had
 * **2.1.251** (observed 2026-08-30) — 159 versions behind, silently. The
 * visible symptom was the Claude plan-usage block staying blank: the newer
 * CLI reports `unifiedWindows` on its rate-limit events and the old one does
 * not, so MARVIN's usage bars had no numbers to show and nothing said why.
 * Version skew like that also quietly changes tool names (ADR-0079) and
 * available flags.
 *
 * `MARVIN_CLAUDE_BIN` still wins outright — an explicit pin is a decision.
 */
export function discoverClaudeBinary(): string {
  if (cachedBinary) return cachedBinary;
  const override = process.env.MARVIN_CLAUDE_BIN?.trim();
  if (override && existsSync(override)) {
    cachedBinary = override;
    return override;
  }

  const candidates: string[] = [...COMMON_CLAUDE_PATHS];
  try {
    const which = execSync("command -v claude", { encoding: "utf-8" }).trim();
    if (which) candidates.push(which);
  } catch {
    // No `claude` on PATH — the fixed list may still have one.
  }

  let best: string | null = null;
  let bestVersion: number[] | null = null;
  const seen = new Set<string>();
  for (const p of candidates) {
    if (!p || seen.has(p) || !existsSync(p)) continue;
    seen.add(p);
    const v = claudeCliVersion(p);
    // First existing candidate wins until something provably newer appears,
    // so an unreadable --version never beats a known-good binary.
    if (best === null || newer(v, bestVersion)) {
      best = p;
      bestVersion = v;
    }
  }
  if (best) {
    cachedBinary = best;
    return best;
  }

  throw new Error(
    "Claude CLI binary not found. Install it (https://docs.claude.com/en/docs/claude-code) or set MARVIN_CLAUDE_BIN.",
  );
}

/* ── Model + timeout ───────────────────────────────────────────────────── */

export function defaultModel(): string {
  // The pair-programming loop is sequential code work — the regime where
  // Opus pulls furthest ahead of Sonnet/Haiku — so the user-facing partner
  // defaults to the newest Opus. Live discovery (resolveRuntimeMode →
  // latestForTier) picks the freshest Opus when online; this sync path is
  // the last resort (env override, else the newest entry in the single
  // hardcoded fallback list in models.ts). No version id lives here. ADR-0029.
  // ADR-0096: `fallbackNewestOfTier` is provider-scoped, and the literal last
  // resort is rewritten for OpenRouter rather than sent as a bare Anthropic id.
  return (
    process.env.MARVIN_MODEL?.trim() ||
    fallbackNewestOfTier("opus") ||
    // Provider-scoped above; this literal is the type-level floor only.
    ensureProviderModelId("claude-opus-4-8") ||
    "claude-opus-4-8"
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
  /**
   * Tool names to hand `--allowedTools`. Pass `[]` for "no tools at
   * all" — the right containment for a one-shot text task like
   * drafting a commit message, which needs the model and nothing else.
   *
   * This matters because every spawn here carries
   * `--dangerously-skip-permissions`: without an explicit allow-list, a
   * prompt-only "just write me a sentence" call is a fully-armed agent
   * pointed at the user's repo. Prompts do not constrain tools; this
   * flag does. Omit the field to keep the default full tool set.
   */
  allowedTools?: string[];
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
    allowedTools,
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
    // `--allowedTools` with an empty value is how the CLI expresses
    // "nothing is permitted"; omitting the flag means "everything".
    ...(allowedTools ? ["--allowedTools", allowedTools.join(",")] : []),
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
