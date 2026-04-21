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

/** Tail-masked form for surfacing in UIs / logs. Never returns the full key. */
export function redactApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return "****";
  return `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
}

function isValidApiUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.endsWith("honeycomb.io");
  } catch {
    return false;
  }
}

function readFile(path: string): HoneycombConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<HoneycombConfig>;
    if (!parsed.apiKey || !parsed.environment) return null;
    const apiUrl = parsed.apiUrl ?? DEFAULT_HONEYCOMB_API_URL;
    if (!isValidApiUrl(apiUrl)) return null;
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
    return {
      config: {
        apiKey: envKey,
        environment: envEnv,
        ...(process.env.HONEYCOMB_DATASET?.trim()
          ? { dataset: process.env.HONEYCOMB_DATASET!.trim() }
          : {}),
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
  | { ok: false; error: "invalid-api-url" | "empty-api-key" | "empty-environment" | "io-error"; detail?: string };

/**
 * Persist a Honeycomb config to `<workDir>/.marvin/honeycomb.json` with
 * 600 permissions. Validates the apiUrl is `https://*.honeycomb.io`
 * before writing so a misconfigured URL can't exfiltrate the key to
 * an attacker-controlled host on subsequent use.
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
