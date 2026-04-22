import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_HONEYCOMB_API_URL,
  deleteHoneycombConfig,
  honeycombConfigStatus,
  readHoneycombConfig,
  redactApiKey,
  writeHoneycombConfig,
} from "../src/honeycomb-config";

// Real tmp-dir tests — honeycomb-config holds an apiKey, which is
// sensitive. File permissions, URL validation, and the no-apiKey-in-
// status invariant all get coverage here so a regression can't
// silently open a leak path.

let tmp: string;
let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "marvin-hc-"));
  // Save + clear env so tests are isolated from the runner's shell
  originalEnv = {
    HONEYCOMB_API_KEY: process.env.HONEYCOMB_API_KEY,
    HONEYCOMB_ENVIRONMENT: process.env.HONEYCOMB_ENVIRONMENT,
    HONEYCOMB_DATASET: process.env.HONEYCOMB_DATASET,
    HONEYCOMB_API_URL: process.env.HONEYCOMB_API_URL,
  };
  for (const k of Object.keys(originalEnv)) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("redactApiKey", () => {
  it("shows only the first 6 + last 4 for a normal key", () => {
    const out = redactApiKey("hcbik_0123456789abcdefghij");
    expect(out).toMatch(/^hcbik_/);
    expect(out).toMatch(/ghij$/);
    expect(out).toContain("…");
    // Never leak the middle
    expect(out).not.toContain("56789abcdef");
  });

  it("just returns **** for suspiciously short input", () => {
    expect(redactApiKey("short")).toBe("****");
  });
});

describe("writeHoneycombConfig", () => {
  it("writes the JSON and returns the absolute path", () => {
    const result = writeHoneycombConfig({
      workDir: tmp,
      apiKey: "hcbik_test_0123456789",
      environment: "prod",
      dataset: "svc",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const body = JSON.parse(readFileSync(result.path, "utf8")) as Record<string, string>;
    expect(body.apiKey).toBe("hcbik_test_0123456789");
    expect(body.environment).toBe("prod");
    expect(body.dataset).toBe("svc");
    expect(body.apiUrl).toBe(DEFAULT_HONEYCOMB_API_URL);
  });

  it("writes with 0600 permissions", () => {
    const result = writeHoneycombConfig({
      workDir: tmp,
      apiKey: "hcbik_abc",
      environment: "prod",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    const mode = statSync(result.path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects an apiUrl outside honeycomb.io", () => {
    const result = writeHoneycombConfig({
      workDir: tmp,
      apiKey: "hcbik_abc",
      environment: "prod",
      apiUrl: "https://evil.example.com",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toBe("invalid-api-url");
  });

  it("rejects http (non-TLS) apiUrls", () => {
    const result = writeHoneycombConfig({
      workDir: tmp,
      apiKey: "hcbik_abc",
      environment: "prod",
      apiUrl: "http://api.honeycomb.io",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toBe("invalid-api-url");
  });

  it("accepts the EU tenant URL", () => {
    const result = writeHoneycombConfig({
      workDir: tmp,
      apiKey: "hcbik_eu",
      environment: "prod",
      apiUrl: "https://api.eu1.honeycomb.io",
    });
    expect(result.ok).toBe(true);
  });

  // Regression: the previous validator used `hostname.endsWith("honeycomb.io")`
  // which happily accepted any attacker-registered lookalike. This
  // test pins the dotted-suffix fix.
  it("rejects lookalike domains ending in 'honeycomb.io' without the leading dot", () => {
    // Anyone can register these. Each one passed the old check.
    const attackerHosts = [
      "https://evilhoneycomb.io",
      "https://myhoneycomb.io",
      "https://api-honeycomb.io",
      "https://attackerhoneycomb.io",
    ];
    for (const apiUrl of attackerHosts) {
      const result = writeHoneycombConfig({
        workDir: tmp,
        apiKey: "hcbik_abc",
        environment: "prod",
        apiUrl,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`accepted: ${apiUrl}`);
      expect(result.error).toBe("invalid-api-url");
    }
  });

  it("rejects environment names with header-injection characters", () => {
    // environment flows into OTEL_RESOURCE_ATTRIBUTES as
    // `honeycomb.environment=<value>,...`. A comma / newline / `=`
    // would splice an attacker-controlled attribute. The validator
    // limits to the charset Honeycomb itself permits.
    const badEnvs = [
      "prod,x-honeycomb-team=attacker",
      "prod\nX-Injected: evil",
      "prod=attacker",
      "prod rm -rf",
      "prod;injected",
    ];
    for (const environment of badEnvs) {
      const result = writeHoneycombConfig({
        workDir: tmp,
        apiKey: "hcbik_abc",
        environment,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`accepted: ${environment}`);
      expect(result.error).toBe("invalid-environment");
    }
  });

  it("rejects dataset names with header-injection characters", () => {
    // dataset flows into OTEL_EXPORTER_OTLP_HEADERS as
    // `x-honeycomb-dataset=<value>`; same injection surface.
    const result = writeHoneycombConfig({
      workDir: tmp,
      apiKey: "hcbik_abc",
      environment: "prod",
      dataset: "claude-code,x-honeycomb-team=attacker",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toBe("invalid-dataset");
  });

  it("accepts the benign charset for environment + dataset", () => {
    // A.B_C-1.2.3 is typical Honeycomb-allowed for both fields.
    const result = writeHoneycombConfig({
      workDir: tmp,
      apiKey: "hcbik_charset",
      environment: "prod.eu_west-1",
      dataset: "claude-code.v1_beta-42",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects empty apiKey / environment", () => {
    expect(
      writeHoneycombConfig({ workDir: tmp, apiKey: "", environment: "prod" })
        .ok,
    ).toBe(false);
    expect(
      writeHoneycombConfig({ workDir: tmp, apiKey: "hcbik_abc", environment: "" })
        .ok,
    ).toBe(false);
    expect(
      writeHoneycombConfig({ workDir: tmp, apiKey: "   ", environment: "prod" })
        .ok,
    ).toBe(false);
  });
});

describe("readHoneycombConfig — env vars", () => {
  it("picks up HONEYCOMB_* env vars", () => {
    process.env.HONEYCOMB_API_KEY = "hcbik_env";
    process.env.HONEYCOMB_ENVIRONMENT = "prod";
    process.env.HONEYCOMB_DATASET = "svc";
    const resolved = readHoneycombConfig(tmp);
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe("env");
    expect(resolved!.config.apiKey).toBe("hcbik_env");
    expect(resolved!.config.environment).toBe("prod");
    expect(resolved!.config.dataset).toBe("svc");
  });

  it("env vars beat workDir config", () => {
    writeHoneycombConfig({
      workDir: tmp,
      apiKey: "hcbik_file",
      environment: "staging",
    });
    process.env.HONEYCOMB_API_KEY = "hcbik_env";
    process.env.HONEYCOMB_ENVIRONMENT = "prod";
    const resolved = readHoneycombConfig(tmp);
    expect(resolved!.source).toBe("env");
    expect(resolved!.config.apiKey).toBe("hcbik_env");
  });

  it("env without an ENVIRONMENT value is treated as not-set", () => {
    process.env.HONEYCOMB_API_KEY = "hcbik_env";
    // no HONEYCOMB_ENVIRONMENT
    writeHoneycombConfig({
      workDir: tmp,
      apiKey: "hcbik_file",
      environment: "staging",
    });
    const resolved = readHoneycombConfig(tmp);
    expect(resolved!.source).toBe("workdir");
  });

  it("env with a bad HONEYCOMB_API_URL rejects the env path", () => {
    process.env.HONEYCOMB_API_KEY = "hcbik_env";
    process.env.HONEYCOMB_ENVIRONMENT = "prod";
    process.env.HONEYCOMB_API_URL = "https://evil.example.com";
    const resolved = readHoneycombConfig(tmp);
    expect(resolved).toBeNull();
  });
});

describe("readHoneycombConfig — file fallback", () => {
  it("returns null when nothing is configured", () => {
    expect(readHoneycombConfig(tmp)).toBeNull();
  });

  it("reads the workDir config when env is absent", () => {
    writeHoneycombConfig({
      workDir: tmp,
      apiKey: "hcbik_file",
      environment: "prod",
    });
    const resolved = readHoneycombConfig(tmp);
    expect(resolved!.source).toBe("workdir");
    expect(resolved!.config.apiKey).toBe("hcbik_file");
    expect(resolved!.path).toContain(".marvin/honeycomb.json");
  });

  it("rejects a file with missing apiKey", () => {
    mkdirSync(path.join(tmp, ".marvin"), { recursive: true });
    const p = path.join(tmp, ".marvin", "honeycomb.json");
    writeFileSync(p, JSON.stringify({ environment: "prod" }), { encoding: "utf8" });
    expect(readHoneycombConfig(tmp)).toBeNull();
  });

  it("rejects a file with a bad apiUrl", () => {
    mkdirSync(path.join(tmp, ".marvin"), { recursive: true });
    const p = path.join(tmp, ".marvin", "honeycomb.json");
    writeFileSync(
      p,
      JSON.stringify({
        apiKey: "hcbik_x",
        environment: "prod",
        apiUrl: "http://honeycomb.io",
      }),
      { encoding: "utf8" },
    );
    expect(readHoneycombConfig(tmp)).toBeNull();
  });

  it("tolerates unreadable files gracefully (returns null, not throws)", () => {
    mkdirSync(path.join(tmp, ".marvin"), { recursive: true });
    const p = path.join(tmp, ".marvin", "honeycomb.json");
    writeFileSync(p, "{ not json", { encoding: "utf8" });
    chmodSync(p, 0o600);
    expect(readHoneycombConfig(tmp)).toBeNull();
  });
});

describe("deleteHoneycombConfig", () => {
  it("removes the file and reports removed: true", () => {
    writeHoneycombConfig({
      workDir: tmp,
      apiKey: "hcbik_abc",
      environment: "prod",
    });
    expect(deleteHoneycombConfig(tmp).removed).toBe(true);
    expect(readHoneycombConfig(tmp)).toBeNull();
  });

  it("reports removed: false when nothing was there", () => {
    expect(deleteHoneycombConfig(tmp).removed).toBe(false);
  });
});

describe("honeycombConfigStatus — masking invariant", () => {
  it("never leaks the raw apiKey through the status object", () => {
    writeHoneycombConfig({
      workDir: tmp,
      apiKey: "hcbik_super_secret_key_0123456789abcdef",
      environment: "prod",
    });
    const status = honeycombConfigStatus(tmp);
    expect(status.configured).toBe(true);
    // The raw key must never appear anywhere in the serialised status.
    const serialised = JSON.stringify(status);
    expect(serialised).not.toContain("super_secret_key_0123456789abcdef");
    // But the mask should be present.
    expect(status.apiKeyMasked).toContain("…");
    expect(status.apiKeyMasked).toMatch(/^hcbik_/);
  });

  it("returns a not-configured status when no source has a key", () => {
    const status = honeycombConfigStatus(tmp);
    expect(status.configured).toBe(false);
    expect(status.apiKeyMasked).toBeNull();
    expect(status.source).toBe("none");
  });
});
