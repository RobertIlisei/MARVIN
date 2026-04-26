/**
 * Auto-export Honeycomb telemetry env vars for the Claude CLI subprocess.
 *
 * MARVIN itself doesn't emit OTEL spans — Claude Code (the CLI) does,
 * when the right env vars are present in its process. Those env vars
 * come from `process.env` at the moment the Agent SDK spawns the CLI;
 * whatever Node's process environment holds at that instant is what
 * the CLI sees. Historically the user had to set them manually in their
 * shell, which broke every time MARVIN was relaunched via a mechanism
 * that didn't inherit the right env (launchd agent, Tauri double-click,
 * fresh terminal).
 *
 * This module closes that gap. On every turn, `runAgent()` calls
 * `applyHoneycombTelemetryEnv(cwd)` before invoking the SDK. If a
 * saved Honeycomb config is present (`<workDir>/.marvin/honeycomb.json`
 * or `~/.marvin/honeycomb.json`, or explicit env vars), the right
 * `CLAUDE_CODE_ENABLE_TELEMETRY` + `OTEL_*` vars are set on
 * `process.env`. The SDK-spawned Claude CLI inherits them and
 * telemetry flows to the configured Honeycomb dataset.
 *
 * Once the user saves a config via Settings → Observability, telemetry
 * works regardless of how MARVIN is launched. No shell exports, no
 * plist edits, no custom launchers.
 *
 * ### Design invariants
 *
 * - **MARVIN-managed keys are tracked.** Anything the module set on a
 *   previous call gets cleared at the top of the next call before
 *   re-evaluating config. That way switching projects (different
 *   workdir → different honeycomb.json) or deleting the config
 *   cleanly reverses the mutation rather than leaking stale values.
 *
 * - **Per-turn isolation via `computeHoneycombTelemetryEnv`.** The
 *   process.env-mutating path (`applyHoneycombTelemetryEnv`) is kept
 *   for the Settings save/delete route where an immediate
 *   `honeycombTelemetryStatus()` call needs to reflect the change.
 *   The SDK runner uses the pure `compute*` form and passes the
 *   resulting env map to `Options.env` per-turn, so two concurrent
 *   turns for two different projects don't race on `process.env`.
 *   Audit finding #4.
 *
 * - **User overrides are respected.** If the user has set
 *   `OTEL_EXPORTER_OTLP_HEADERS` in the shell / plist themselves,
 *   the module leaves the entire OTEL surface alone. This preserves
 *   the escape hatch for advanced setups (e.g. shipping to a self-
 *   hosted OTEL collector instead of Honeycomb direct).
 *
 * - **Dataset targeting.** Honeycomb routes OTLP payloads by the
 *   `x-honeycomb-dataset` header. When the user sets a default
 *   dataset in config, we use it; otherwise Claude Code's logs land
 *   in the `claude-code` dataset (the convention Anthropic's own
 *   docs use as an example).
 *
 * - **Signals: metrics + logs.** Claude Code emits OTEL metrics
 *   (turn counters, token usage) and logs (tool calls, events). We
 *   enable both exporters. Traces are not emitted by the CLI today;
 *   setting `OTEL_TRACES_EXPORTER=otlp` would be a no-op.
 */

import {
  DEFAULT_HONEYCOMB_API_URL,
  type HoneycombConfigSource,
  readHoneycombConfig,
} from "./honeycomb-config";

export interface HoneycombTelemetryStatus {
  /**
   * `true` when env vars are set — either by MARVIN (from a saved
   * config) or by the user (explicit OTEL_EXPORTER_OTLP_HEADERS).
   */
  active: boolean;
  /** Which source MARVIN read from, or "user" for explicit overrides. */
  source: HoneycombConfigSource | "user-override";
  /**
   * The Honeycomb endpoint the CLI will target, when active. Surfaced
   * to the UI so the user sees e.g. "sending to api.eu1.honeycomb.io".
   */
  endpoint: string | null;
  /**
   * The dataset tag traces will land in, when active. `null` for
   * user-override mode (we can't parse their headers) or when
   * inactive.
   */
  dataset: string | null;
}

/**
 * Env var keys MARVIN controls. Kept in a module-scoped Set so the
 * next call can cleanly clear everything we previously set. Never
 * includes keys MARVIN hasn't touched, so it can't accidentally
 * delete user-set vars on cleanup.
 */
const MARVIN_MANAGED_KEYS = new Set<string>();

const DEFAULT_DATASET = "claude-code";
const DEFAULT_SERVICE_NAME = "claude-code";

/**
 * Pure form: compute the Honeycomb env vars for a given workdir's
 * config WITHOUT mutating `process.env`. Returns the env map the
 * caller should merge into the SDK's `Options.env` (or any other
 * per-call env path) plus the status string for reporting.
 *
 * Used by the SDK runner per turn so concurrent turns for different
 * projects don't race on a shared global. The Settings save/delete
 * route still uses `applyHoneycombTelemetryEnv` (below) because it
 * wants an immediate `honeycombTelemetryStatus()` to reflect the
 * change in the same request.
 *
 * Audit finding #4.
 */
export function computeHoneycombTelemetryEnv(
  workDir: string | null,
  /**
   * Optional inherited env. If the user has already set
   * `OTEL_EXPORTER_OTLP_HEADERS` here (shell / launchd plist),
   * we leave the entire OTEL surface alone — same escape hatch
   * as the mutating form. Defaults to `process.env` so callers
   * don't have to thread it.
   */
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): { env: Record<string, string>; status: HoneycombTelemetryStatus } {
  // Escape hatch — caller is driving telemetry by hand; we don't
  // emit any OTEL keys at all.
  if (inheritedEnv.OTEL_EXPORTER_OTLP_HEADERS) {
    return {
      env: {},
      status: {
        active: true,
        source: "user-override",
        endpoint: inheritedEnv.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
        dataset: null,
      },
    };
  }

  const resolved = readHoneycombConfig(workDir);
  if (!resolved) {
    return {
      env: {},
      status: { active: false, source: "none", endpoint: null, dataset: null },
    };
  }

  const { apiKey, environment, apiUrl, dataset } = resolved.config;
  const endpoint = apiUrl ?? DEFAULT_HONEYCOMB_API_URL;
  const targetDataset = dataset ?? DEFAULT_DATASET;

  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_HEADERS: `x-honeycomb-team=${apiKey},x-honeycomb-dataset=${targetDataset}`,
    OTEL_SERVICE_NAME: DEFAULT_SERVICE_NAME,
    OTEL_RESOURCE_ATTRIBUTES: `honeycomb.environment=${environment},honeycomb.dataset=${targetDataset}`,
  };

  return {
    env,
    status: {
      active: true,
      source: resolved.source,
      endpoint,
      dataset: targetDataset,
    },
  };
}

export function applyHoneycombTelemetryEnv(
  workDir: string | null,
): HoneycombTelemetryStatus {
  // Clear anything MARVIN previously set. This matters when the user
  // deletes their Honeycomb config (or switches to a project with
  // no config) mid-session — without the sweep, stale headers from
  // the previous project would continue shipping spans.
  for (const k of MARVIN_MANAGED_KEYS) {
    delete process.env[k];
  }
  MARVIN_MANAGED_KEYS.clear();

  // Delegate to the pure form so both code paths stay in lockstep.
  // The mutating wrapper only exists because the Settings route wants
  // `honeycombTelemetryStatus()` (which reads `process.env`) to
  // reflect the change in the same HTTP response. Per-turn callers
  // (sdk-runner) should reach for `computeHoneycombTelemetryEnv`
  // instead — it's the race-free path.
  const { env, status } = computeHoneycombTelemetryEnv(workDir);
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
    MARVIN_MANAGED_KEYS.add(k);
  }
  return status;
}

/**
 * Read-only accessor for tests / status endpoints that want to know
 * whether MARVIN currently has telemetry vars exported, without
 * triggering a re-apply. Mirrors the real process.env state rather
 * than recomputing from config (so the UI agrees with what the CLI
 * will actually see).
 */
export function honeycombTelemetryStatus(): HoneycombTelemetryStatus {
  // User-override case: they set headers themselves.
  if (
    process.env.OTEL_EXPORTER_OTLP_HEADERS &&
    !MARVIN_MANAGED_KEYS.has("OTEL_EXPORTER_OTLP_HEADERS")
  ) {
    return {
      active: true,
      source: "user-override",
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
      dataset: null,
    };
  }
  // MARVIN-managed case: it's active iff we've actually written the
  // flag. An empty MARVIN_MANAGED_KEYS set on a fresh process counts
  // as inactive — `applyHoneycombTelemetryEnv` hasn't been called yet.
  if (MARVIN_MANAGED_KEYS.has("CLAUDE_CODE_ENABLE_TELEMETRY")) {
    const headers = process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "";
    const match = /x-honeycomb-dataset=([^,]+)/.exec(headers);
    return {
      active: true,
      source: "workdir",
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
      dataset: match?.[1] ?? null,
    };
  }
  return { active: false, source: "none", endpoint: null, dataset: null };
}

/**
 * Test-only reset. Clears the internal "MARVIN-managed keys" set AND
 * unsets those keys on process.env. Production callers don't need
 * this; it exists so vitest tests can isolate runs without leaking
 * state across test cases.
 */
export function _resetHoneycombTelemetryForTests(): void {
  for (const k of MARVIN_MANAGED_KEYS) {
    delete process.env[k];
  }
  MARVIN_MANAGED_KEYS.clear();
}
