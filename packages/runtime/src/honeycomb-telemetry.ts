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

  // Escape hatch: if the user has explicitly set OTLP headers in their
  // shell or launchd plist, they're driving telemetry manually. Don't
  // touch the OTEL surface. We still signal "active" so the UI can
  // show a "telemetry flowing (custom setup)" badge instead of
  // "not configured."
  if (process.env.OTEL_EXPORTER_OTLP_HEADERS) {
    return {
      active: true,
      source: "user-override",
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
      dataset: null,
    };
  }

  const resolved = readHoneycombConfig(workDir);
  if (!resolved) {
    return { active: false, source: "none", endpoint: null, dataset: null };
  }

  const { apiKey, environment, apiUrl, dataset } = resolved.config;
  const endpoint = apiUrl ?? DEFAULT_HONEYCOMB_API_URL;
  const targetDataset = dataset ?? DEFAULT_DATASET;

  const apply = (key: string, value: string): void => {
    process.env[key] = value;
    MARVIN_MANAGED_KEYS.add(key);
  };

  // Claude Code gates all OTEL emission on this one flag. Without it,
  // everything else below is ignored — the CLI skips the entire
  // telemetry code path.
  apply("CLAUDE_CODE_ENABLE_TELEMETRY", "1");

  // Claude Code emits metrics + logs today; pick the OTLP exporter for
  // both. Traces aren't emitted by the CLI yet, so leaving
  // OTEL_TRACES_EXPORTER unset costs nothing.
  apply("OTEL_METRICS_EXPORTER", "otlp");
  apply("OTEL_LOGS_EXPORTER", "otlp");

  // Honeycomb's OTLP ingress prefers http/protobuf. grpc works too but
  // requires a separate port and is more finicky on corporate networks.
  apply("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf");
  apply("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);

  // Headers carry the API key and dataset. Honeycomb routes payloads
  // by (team, dataset); the team is implicit from the API key but the
  // dataset header is what pins the data to a specific Honeycomb
  // dataset. Without it, ingested metrics land in the default
  // `unknown_logs` / `unknown_metrics` datasets, which is confusing.
  apply(
    "OTEL_EXPORTER_OTLP_HEADERS",
    `x-honeycomb-team=${apiKey},x-honeycomb-dataset=${targetDataset}`,
  );

  // Service name surfaces in Honeycomb's "services" dropdown. Resource
  // attributes carry the environment label so the user can split
  // charts by prod vs staging even when the same dataset receives
  // spans from multiple environments.
  apply("OTEL_SERVICE_NAME", DEFAULT_SERVICE_NAME);
  apply(
    "OTEL_RESOURCE_ATTRIBUTES",
    `honeycomb.environment=${environment},honeycomb.dataset=${targetDataset}`,
  );

  return {
    active: true,
    source: resolved.source,
    endpoint,
    dataset: targetDataset,
  };
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
