import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetHoneycombTelemetryForTests,
  applyHoneycombTelemetryEnv,
  honeycombTelemetryStatus,
} from "../src/honeycomb-telemetry";

// These tests mutate process.env. Each `beforeEach` captures the
// baseline and the `afterEach` restores it, so one test can't leak
// OTEL_* or HONEYCOMB_* vars into the next. The internal module state
// (MARVIN_MANAGED_KEYS) is reset via the test-only helper.

const RELEVANT_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "HONEYCOMB_API_KEY",
  "HONEYCOMB_ENVIRONMENT",
  "HONEYCOMB_DATASET",
  "HONEYCOMB_API_URL",
] as const;

let origEnv: Record<string, string | undefined>;
let workDir: string;

beforeEach(() => {
  origEnv = {};
  for (const k of RELEVANT_KEYS) {
    origEnv[k] = process.env[k];
    delete process.env[k];
  }
  workDir = mkdtempSync(path.join(tmpdir(), "marvin-honeycomb-"));
  _resetHoneycombTelemetryForTests();
});

afterEach(() => {
  _resetHoneycombTelemetryForTests();
  for (const k of RELEVANT_KEYS) {
    if (origEnv[k] === undefined) delete process.env[k];
    else process.env[k] = origEnv[k];
  }
});

function writeConfig(
  dir: string,
  cfg: {
    apiKey?: string;
    environment?: string;
    dataset?: string;
    apiUrl?: string;
  },
): string {
  const marvinDir = path.join(dir, ".marvin");
  mkdirSync(marvinDir, { recursive: true });
  const p = path.join(marvinDir, "honeycomb.json");
  writeFileSync(p, JSON.stringify(cfg), "utf8");
  chmodSync(p, 0o600);
  return p;
}

describe("applyHoneycombTelemetryEnv", () => {
  it("is inactive when no config exists anywhere", () => {
    const result = applyHoneycombTelemetryEnv(workDir);
    expect(result.active).toBe(false);
    expect(result.source).toBe("none");
    // Env must stay clean — no keys MARVIN might have touched.
    for (const k of RELEVANT_KEYS.slice(0, 8)) {
      expect(process.env[k]).toBeUndefined();
    }
  });

  it("exports the full OTEL env surface when a workdir config is present", () => {
    writeConfig(workDir, {
      apiKey: "hcbik_test_key",
      environment: "prod",
      dataset: "marvin-traces",
    });

    const result = applyHoneycombTelemetryEnv(workDir);
    expect(result.active).toBe(true);
    expect(result.source).toBe("workdir");
    expect(result.endpoint).toBe("https://api.honeycomb.io");
    expect(result.dataset).toBe("marvin-traces");

    // The load-bearing one — without it, Claude Code skips the whole
    // telemetry code path regardless of the other vars.
    expect(process.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");

    // Metrics + logs exporters target OTLP so they route through
    // OTEL_EXPORTER_OTLP_* settings below.
    expect(process.env.OTEL_METRICS_EXPORTER).toBe("otlp");
    expect(process.env.OTEL_LOGS_EXPORTER).toBe("otlp");

    // Honeycomb prefers http/protobuf over grpc (fewer ports, less
    // corporate-firewall drama).
    expect(process.env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/protobuf");
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      "https://api.honeycomb.io",
    );

    // Headers carry the team (api key) + dataset. Missing headers →
    // Honeycomb drops the payload or routes it to `unknown_*` datasets.
    expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toContain(
      "x-honeycomb-team=hcbik_test_key",
    );
    expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toContain(
      "x-honeycomb-dataset=marvin-traces",
    );

    // Environment name lives in resource attributes so dashboards can
    // split by prod/staging without duplicating datasets.
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toContain(
      "honeycomb.environment=prod",
    );
  });

  it("uses the EU endpoint when the config specifies it", () => {
    writeConfig(workDir, {
      apiKey: "hcbik_eu",
      environment: "prod",
      apiUrl: "https://api.eu1.honeycomb.io",
    });
    const result = applyHoneycombTelemetryEnv(workDir);
    expect(result.endpoint).toBe("https://api.eu1.honeycomb.io");
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
      "https://api.eu1.honeycomb.io",
    );
  });

  it("falls back to the 'claude-code' dataset when none is configured", () => {
    // Common case: user saves just apiKey + environment and trusts the
    // default dataset. Without this fallback, spans would land in
    // Honeycomb's generic "unknown_logs" slot and be invisible.
    writeConfig(workDir, {
      apiKey: "hcbik_nodefault",
      environment: "prod",
    });
    const result = applyHoneycombTelemetryEnv(workDir);
    expect(result.dataset).toBe("claude-code");
    expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toContain(
      "x-honeycomb-dataset=claude-code",
    );
  });

  it("respects a user-set OTEL_EXPORTER_OTLP_HEADERS as an escape hatch", () => {
    // Power user who wants to ship to a custom OTEL collector instead
    // of Honeycomb direct should be able to set headers themselves and
    // have MARVIN stay out of the way.
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer custom";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.com";
    writeConfig(workDir, {
      apiKey: "hcbik_should_be_ignored",
      environment: "prod",
    });

    const result = applyHoneycombTelemetryEnv(workDir);
    expect(result.active).toBe(true);
    expect(result.source).toBe("user-override");

    // Headers must remain exactly what the user set — no merging, no
    // overwriting. Anything else breaks their authorization.
    expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(
      "authorization=Bearer custom",
    );
    // The CLAUDE_CODE_ENABLE_TELEMETRY flag is deliberately NOT set by
    // MARVIN in this path — the user is driving telemetry manually and
    // may have their own flag logic.
    expect(process.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
  });

  it("clears previously-set MARVIN-managed vars when config is removed", () => {
    // First save, verify active.
    writeConfig(workDir, {
      apiKey: "hcbik_first",
      environment: "prod",
    });
    applyHoneycombTelemetryEnv(workDir);
    expect(process.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");

    // Delete the config file (simulate user clicking "remove config").
    const cfgPath = path.join(workDir, ".marvin", "honeycomb.json");
    // Overwrite with an invalid file so the reader returns null; same
    // net effect as unlinking without pulling in fs.unlinkSync here.
    writeFileSync(cfgPath, "{}");

    // Re-apply — must clear the previously-exported keys. Otherwise
    // stale headers would keep shipping spans after the user thought
    // they'd disabled Honeycomb.
    const result = applyHoneycombTelemetryEnv(workDir);
    expect(result.active).toBe(false);
    expect(process.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
    expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it("rotates cleanly when the user swaps API keys mid-session", () => {
    writeConfig(workDir, {
      apiKey: "hcbik_old",
      environment: "prod",
    });
    applyHoneycombTelemetryEnv(workDir);
    expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toContain("hcbik_old");

    writeConfig(workDir, {
      apiKey: "hcbik_new",
      environment: "prod",
    });
    applyHoneycombTelemetryEnv(workDir);
    // The old key must be gone — otherwise spans get two conflicting
    // team headers and Honeycomb rejects them silently.
    expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).not.toContain("hcbik_old");
    expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toContain("hcbik_new");
  });

  it("honeycombTelemetryStatus reports the live env state", () => {
    // Inactive before any call.
    expect(honeycombTelemetryStatus().active).toBe(false);

    writeConfig(workDir, {
      apiKey: "hcbik_status",
      environment: "prod",
      dataset: "my-dataset",
    });
    applyHoneycombTelemetryEnv(workDir);

    const status = honeycombTelemetryStatus();
    expect(status.active).toBe(true);
    expect(status.dataset).toBe("my-dataset");
    expect(status.endpoint).toBe("https://api.honeycomb.io");
  });
});
