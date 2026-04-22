/**
 * Honeycomb telemetry-API config for MARVIN's `marvin-honeycomb` MCP
 * server (see ADR-0005 for the isolation contract that drives the
 * per-project storage layout).
 *
 * Resolution precedence, highest priority first:
 *   1. `HONEYCOMB_API_KEY` + `HONEYCOMB_ENVIRONMENT` + `HONEYCOMB_DATASET`
 *      env vars. Useful for CI / one-off debugging.
 *   2. `<workDir>/.marvin/honeycomb.json` — per-project config edited
 *      via MARVIN's UI. This is the expected path.
 *   3. `~/.marvin/honeycomb.json` — user-global fallback when the
 *      workDir doesn't have its own config.
 *
 * The file format is a plain `HoneycombConfig` JSON dict; the loader
 * rejects missing apiKey fields and returns null rather than a
 * partially-configured record.
 *
 * Secrecy note: this module NEVER logs the raw apiKey. Callers that
 * need to surface the config to the UI use `redactApiKey()` to produce
 * a safe "hcbik_****abcd" representation.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface HoneycombConfig {
  /** `hcbik_…` — read/write permission depends on usage. */
  apiKey: string;
  /** Honeycomb environment name (often "prod" or the team default). */
  environment: string;
  /** Primary dataset MARVIN should target if not otherwise specified. */
  dataset?: string;
  /** Alternative API endpoint — `https://api.eu1.honeycomb.io` for EU tenants. */
  apiUrl?: string;
}

export type HoneycombConfigSource = "env" | "workdir" | "global" | "none";

export interface HoneycombConfigStatus {
  configured: boolean;
  source: HoneycombConfigSource;
  apiKeyMasked: string | null;
  environment: string | null;
  dataset: string | null;
  apiUrl: string;
  path: string | null;
}

export const DEFAULT_HONEYCOMB_API_URL = "https://api.honeycomb.io";
export const EU_HONEYCOMB_API_URL = "https://api.eu1.honeycomb.io";

/**
 * Honeycomb runs two independently-keyed clusters: US (default) and EU
 * (`*.eu1.*`). A key minted in one region is unknown to the other, so
 * MARVIN keeps a short list of canonical hosts to probe when the user
 * doesn't pick explicitly. Ordered most-common-first for fewer round
 * trips on the happy path.
 */
export const HONEYCOMB_CANDIDATE_URLS: readonly string[] = [
  DEFAULT_HONEYCOMB_API_URL,
  EU_HONEYCOMB_API_URL,
];

/** Tail-masked form for surfacing in UIs / logs. Never returns the full key. */
export function redactApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return "****";
  return `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
}

/**
 * Strict Honeycomb hostname validator.
 *
 * The previous form used `hostname.endsWith("honeycomb.io")`, which had
 * a one-character SSRF bug: any attacker-registered domain suffixed
 * with that substring — `evilhoneycomb.io`, `myhoneycomb.io` —
 * passed the check. Combined with a CSRF primitive on
 * `POST /api/honeycomb/config`, a malicious same-browser origin could
 * redirect outbound telemetry + the `/1/auth` probe to a host it
 * controls and exfiltrate the API key.
 *
 * The tight form requires the hostname to END WITH `.honeycomb.io`
 * (note the leading dot). A dotted suffix only matches if the
 * character before "honeycomb.io" is a `.` — i.e. it's a genuine
 * subdomain of Honeycomb's domain. This rejects `evilhoneycomb.io`
 * (ends with "honeycomb.io" without the dot) while still accepting
 * any legitimate Honeycomb region (`api.honeycomb.io`,
 * `api.eu1.honeycomb.io`, future `api.ap1.honeycomb.io`, etc.).
 *
 * HTTPS-only is retained from the original check. Non-HTTPS would
 * expose the API key on the wire even if the hostname is legitimate.
 */
function isValidApiUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.endsWith(".honeycomb.io");
  } catch {
    return false;
  }
}

/**
 * Validator for user-supplied config strings that flow unescaped into
 * OTEL env vars (headers, resource attributes). `environment` lands
 * inside `OTEL_RESOURCE_ATTRIBUTES` and `dataset` lands inside
 * `OTEL_EXPORTER_OTLP_HEADERS` as
 * `x-honeycomb-dataset=<value>` — in both cases a comma, newline, or
 * `=` would terminate the key and allow the user to splice an
 * attacker-controlled header or attribute.
 *
 * Allowed characters mirror what the Honeycomb UI itself permits for
 * environment/dataset names: alphanumerics plus `._-`. 128-char cap
 * is generous but bounded (Honeycomb rejects names over 64 bytes, so
 * anything longer is clearly malicious / mistyped).
 *
 * Low real-world risk for a single-user local tool — MARVIN writes
 * its own config. But the whole point of ADR-0004's structural gates
 * is that prompt hygiene isn't the only defence. Validate at the
 * trust boundary (write) so stale or crafted files can't get past
 * the reader either.
 */
const CONFIG_NAME_RE = /^[A-Za-z0-9._-]+$/;
const CONFIG_NAME_MAX = 128;

function isValidConfigName(value: string): boolean {
  return (
    value.length > 0 && value.length <= CONFIG_NAME_MAX && CONFIG_NAME_RE.test(value)
  );
}

function readFile(path: string): HoneycombConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<HoneycombConfig>;
    if (!parsed.apiKey || !parsed.environment) return null;
    const apiUrl = parsed.apiUrl ?? DEFAULT_HONEYCOMB_API_URL;
    if (!isValidApiUrl(apiUrl)) return null;
    // Belt-and-braces: enforce the same charset on read that we enforce
    // on write. If a stale config file from before the validator was
    // added carries a value with a comma / newline / `=`, drop it
    // rather than passing it through to the OTEL headers the telemetry
    // module will build later.
    if (!isValidConfigName(parsed.environment)) return null;
    if (parsed.dataset !== undefined && !isValidConfigName(parsed.dataset)) {
      return null;
    }
    return {
      apiKey: parsed.apiKey,
      environment: parsed.environment,
      ...(parsed.dataset ? { dataset: parsed.dataset } : {}),
      apiUrl,
    };
  } catch {
    return null;
  }
}

function workDirConfigPath(workDir: string): string {
  return path.join(workDir, ".marvin", "honeycomb.json");
}

function globalConfigPath(): string {
  return path.join(homedir(), ".marvin", "honeycomb.json");
}

/**
 * Resolve the active Honeycomb config across the three sources.
 * Returns null when nothing is configured anywhere.
 */
export function readHoneycombConfig(workDir: string | null): {
  config: HoneycombConfig;
  source: HoneycombConfigSource;
  path: string | null;
} | null {
  const envKey = process.env.HONEYCOMB_API_KEY?.trim();
  const envEnv = process.env.HONEYCOMB_ENVIRONMENT?.trim();
  if (envKey && envEnv) {
    const apiUrl =
      process.env.HONEYCOMB_API_URL?.trim() || DEFAULT_HONEYCOMB_API_URL;
    if (!isValidApiUrl(apiUrl)) return null;
    // Apply the same charset check to env-var-sourced values. In theory
    // the user sets these deliberately in their shell, but the user's
    // shell is also the surface that proved fragile on the install-app
    // launch path — better to fail closed than pass a crafted value
    // through to OTEL headers.
    if (!isValidConfigName(envEnv)) return null;
    const envDataset = process.env.HONEYCOMB_DATASET?.trim();
    if (envDataset !== undefined && envDataset !== "" && !isValidConfigName(envDataset)) {
      return null;
    }
    return {
      config: {
        apiKey: envKey,
        environment: envEnv,
        ...(envDataset ? { dataset: envDataset } : {}),
        apiUrl,
      },
      source: "env",
      path: null,
    };
  }

  if (workDir) {
    const p = workDirConfigPath(workDir);
    const c = readFile(p);
    if (c) return { config: c, source: "workdir", path: p };
  }

  const gp = globalConfigPath();
  const c = readFile(gp);
  if (c) return { config: c, source: "global", path: gp };

  return null;
}

export interface WriteHoneycombConfigInput {
  workDir: string;
  apiKey: string;
  environment: string;
  dataset?: string;
  apiUrl?: string;
}

export type WriteHoneycombConfigResult =
  | { ok: true; path: string }
  | {
      ok: false;
      error:
        | "invalid-api-url"
        | "empty-api-key"
        | "empty-environment"
        | "invalid-environment"
        | "invalid-dataset"
        | "io-error";
      detail?: string;
    };

/**
 * Persist a Honeycomb config to `<workDir>/.marvin/honeycomb.json` with
 * 600 permissions. Validates:
 *
 *   - apiUrl is strictly `https://*.honeycomb.io` (dot required, so a
 *     lookalike domain like `evilhoneycomb.io` is rejected).
 *   - environment + dataset (if present) match
 *     `[A-Za-z0-9._-]{1,128}` — the charset Honeycomb itself allows,
 *     and the minimum set that prevents header injection when these
 *     values get concatenated into `OTEL_EXPORTER_OTLP_HEADERS` /
 *     `OTEL_RESOURCE_ATTRIBUTES` downstream (a comma or newline in an
 *     unvalidated value would splice a second header).
 *
 * The two validators together close the SSRF → key-exfiltration path
 * that a CSRF on this endpoint would otherwise enable: no funny
 * hostname, no crafted dataset that smuggles a `x-honeycomb-team=`
 * override.
 */
export function writeHoneycombConfig(
  input: WriteHoneycombConfigInput,
): WriteHoneycombConfigResult {
  const apiKey = input.apiKey.trim();
  const environment = input.environment.trim();
  const dataset = input.dataset?.trim();
  const apiUrl = input.apiUrl?.trim() || DEFAULT_HONEYCOMB_API_URL;

  if (!apiKey) return { ok: false, error: "empty-api-key" };
  if (!environment) return { ok: false, error: "empty-environment" };
  if (!isValidConfigName(environment)) {
    return {
      ok: false,
      error: "invalid-environment",
      detail: "must match [A-Za-z0-9._-] (1-128 chars)",
    };
  }
  if (dataset !== undefined && dataset !== "" && !isValidConfigName(dataset)) {
    return {
      ok: false,
      error: "invalid-dataset",
      detail: "must match [A-Za-z0-9._-] (1-128 chars)",
    };
  }
  if (!isValidApiUrl(apiUrl)) {
    return {
      ok: false,
      error: "invalid-api-url",
      detail: "must be https:// on a honeycomb.io host",
    };
  }

  const target = workDirConfigPath(input.workDir);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    const payload: HoneycombConfig = {
      apiKey,
      environment,
      ...(dataset ? { dataset } : {}),
      apiUrl,
    };
    writeFileSync(target, JSON.stringify(payload, null, 2), { encoding: "utf8" });
    try {
      chmodSync(target, 0o600);
    } catch {
      // Best-effort on platforms that don't support POSIX perms; the
      // file is still under .marvin/ which MARVIN treats as gitignored.
    }
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: "io-error", detail: String(e) };
  }
}

/**
 * Remove the per-project config file. No-op when already absent.
 * Does NOT touch the user-global fallback or env vars.
 */
export function deleteHoneycombConfig(workDir: string): { removed: boolean } {
  const target = workDirConfigPath(workDir);
  if (!existsSync(target)) return { removed: false };
  try {
    unlinkSync(target);
    return { removed: true };
  } catch {
    return { removed: false };
  }
}

/** Build the summary the UI renders — masked apiKey, path pointer. */
export function honeycombConfigStatus(
  workDir: string | null,
): HoneycombConfigStatus {
  const resolved = readHoneycombConfig(workDir);
  if (!resolved) {
    return {
      configured: false,
      source: "none",
      apiKeyMasked: null,
      environment: null,
      dataset: null,
      apiUrl: DEFAULT_HONEYCOMB_API_URL,
      path: workDir ? workDirConfigPath(workDir) : null,
    };
  }
  return {
    configured: true,
    source: resolved.source,
    apiKeyMasked: redactApiKey(resolved.config.apiKey),
    environment: resolved.config.environment,
    dataset: resolved.config.dataset ?? null,
    apiUrl: resolved.config.apiUrl ?? DEFAULT_HONEYCOMB_API_URL,
    path: resolved.path,
  };
}

/* -------------------------------------------------------------------------
 * Region probing
 * ---------------------------------------------------------------------- */

export interface HoneycombProbeSuccess {
  ok: true;
  apiUrl: string;
  team: { name: string | null; slug: string | null };
  environment: { name: string | null; slug: string | null };
  apiKeyAccess: Record<string, boolean>;
}

export interface HoneycombProbeFailure {
  ok: false;
  /** The last error we hit (usually the second try). */
  error: "unauthorized" | "network-error" | "upstream-error";
  status?: number;
  detail?: string;
  /** Every host we tried + their result — helps the UI show "we tried US and EU". */
  attempts: Array<{
    apiUrl: string;
    status: number | "network-error";
    detail?: string;
  }>;
}

export type HoneycombProbeResult = HoneycombProbeSuccess | HoneycombProbeFailure;

interface AuthResponseShape {
  api_key_access?: Record<string, boolean>;
  environment?: { name?: string; slug?: string };
  team?: { name?: string; slug?: string };
}

/**
 * Hit `GET /1/auth` on a specific Honeycomb cluster with the given
 * apiKey. The cluster is identified by `apiUrl` (e.g.
 * `https://api.honeycomb.io` or `https://api.eu1.honeycomb.io`). A 401
 * is treated as a negative result (the key isn't valid on that cluster)
 * rather than a transport error. Other non-2xx responses and network
 * errors propagate as failures.
 *
 * This is a standalone primitive — `probeHoneycombKey` wraps it to
 * walk the candidate-URL list. Exposed directly for tests and callers
 * that want to hit a single cluster.
 */
export async function probeHoneycombKeyAt(
  apiKey: string,
  apiUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<
  | { ok: true; payload: AuthResponseShape }
  | { ok: false; status: number | "network-error"; detail?: string }
> {
  const base = apiUrl.replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 6_000;
  try {
    const res = await fetch(`${base}/1/auth`, {
      method: "GET",
      headers: {
        "X-Honeycomb-Team": apiKey,
        "User-Agent": "marvin/0.0.1",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) {
      return { ok: false, status: 401, detail: "unauthorized" };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, detail: `upstream ${res.status}` };
    }
    const payload = (await res.json()) as AuthResponseShape;
    return { ok: true, payload };
  } catch (e) {
    return {
      ok: false,
      status: "network-error",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Probe one or more Honeycomb clusters with the given apiKey and return
 * the first one that authenticates successfully. Used by:
 *
 *   - `POST /api/honeycomb/config` to auto-select the right cluster
 *     when the user didn't pick explicitly (Honeycomb doesn't tell you
 *     from the key alone which region minted it).
 *   - `POST /api/honeycomb/test` as a fallback when the saved cluster
 *     rejects the key — catches the "I moved regions / regenerated in
 *     the wrong region" footgun.
 *
 * @param apiKey  the Honeycomb API key to validate.
 * @param candidates  ordered list of apiUrls to try. Defaults to US → EU.
 *                    Pass a single-element array to force one cluster.
 */
export async function probeHoneycombKey(
  apiKey: string,
  candidates: readonly string[] = HONEYCOMB_CANDIDATE_URLS,
): Promise<HoneycombProbeResult> {
  const attempts: HoneycombProbeFailure["attempts"] = [];
  let lastFail: { status: number | "network-error"; detail?: string } | null =
    null;

  for (const apiUrl of candidates) {
    if (!isValidApiUrl(apiUrl)) continue;
    const r = await probeHoneycombKeyAt(apiKey, apiUrl);
    if (r.ok) {
      return {
        ok: true,
        apiUrl,
        team: {
          name: r.payload.team?.name ?? null,
          slug: r.payload.team?.slug ?? null,
        },
        environment: {
          name: r.payload.environment?.name ?? null,
          slug: r.payload.environment?.slug ?? null,
        },
        apiKeyAccess: r.payload.api_key_access ?? {},
      };
    }
    attempts.push({
      apiUrl,
      status: r.status,
      ...(r.detail ? { detail: r.detail } : {}),
    });
    lastFail = r;
  }

  // Classify: if *every* attempt was 401, it's definitively a bad key.
  // If any was a network or upstream error, surface that as the reason
  // since a single 401 on an unreachable cluster is misleading.
  const allUnauthorized = attempts.every((a) => a.status === 401);
  const errorKind: HoneycombProbeFailure["error"] = allUnauthorized
    ? "unauthorized"
    : lastFail?.status === "network-error"
      ? "network-error"
      : "upstream-error";
  return {
    ok: false,
    error: errorKind,
    ...(typeof lastFail?.status === "number" ? { status: lastFail.status } : {}),
    ...(lastFail?.detail ? { detail: lastFail.detail } : {}),
    attempts,
  };
}
