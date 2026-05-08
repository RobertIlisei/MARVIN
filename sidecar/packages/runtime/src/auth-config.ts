/**
 * MARVIN's UI-managed Anthropic auth config.
 *
 * Lets the user pick — from the macOS app's Settings panel — whether MARVIN
 * sends inferences via:
 *
 *   - mode "cli"     — the host's Claude Code login (auto-detected from
 *                      `~/.claude/`). This is the default; matches the
 *                      pre-existing fallback path.
 *   - mode "api-key" — a direct Anthropic API key supplied through the UI.
 *                      Stored at `~/.marvin/auth-config.json` with `0600`.
 *
 * Resolution precedence (in `auth.ts`):
 *   1. UI config: `mode === "api-key"` AND `apiKey` present  →  use that key.
 *   2. UI config: `mode === "cli"`  →  go straight to host-credentials, do
 *      NOT consult `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` env vars.
 *   3. No UI config file (the default for fresh installs)  →  fall through to
 *      the env-var chain, then host-credentials. Pre-existing behaviour.
 *
 * Secrecy note: this module NEVER logs or returns the raw apiKey via the
 * status surface. UI consumers see `keyHint` (last 4 chars) only.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type AuthConfigMode = "cli" | "api-key";

export interface AuthConfig {
  mode: AuthConfigMode;
  /** Present iff mode === "api-key". sk-ant-* / OAuth-shaped tokens both ok. */
  apiKey?: string;
  /** ISO timestamp of last write. Diagnostic only. */
  savedAt?: string;
}

export interface AuthConfigStatus {
  /** Mode the user has explicitly chosen. `null` if no config file exists. */
  mode: AuthConfigMode | null;
  /** Last-4 hint (e.g. `…wxyz`) for UI display. Null when no key is stored. */
  keyHint: string | null;
  /** ISO timestamp of last write. Null when no config file exists. */
  savedAt: string | null;
  /** Absolute path of the config file (whether it exists or not). */
  path: string;
}

function authConfigPath(): string {
  // MARVIN_DATA_DIR overrides the parent dir; mirrors how
  // `cost-tracker.json`, `projects.json`, and `~/.marvin/honeycomb.json`
  // resolve. Auth is global (per-user, cross-project), so this lives at
  // the data-dir root, not inside any `<workDir>/.marvin/`.
  const root = process.env.MARVIN_DATA_DIR?.trim() || path.join(homedir(), ".marvin");
  return path.join(root, "auth-config.json");
}

function ensureParentDir(p: string): void {
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function keyHint(apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  if (apiKey.length < 4) return "…";
  return `…${apiKey.slice(-4)}`;
}

/** Read the config from disk. Returns null when the file is absent or malformed. */
export function readAuthConfig(): AuthConfig | null {
  const p = authConfigPath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<AuthConfig>;
    if (raw.mode !== "cli" && raw.mode !== "api-key") return null;
    if (raw.mode === "api-key" && (!raw.apiKey || typeof raw.apiKey !== "string")) {
      // mode="api-key" without a key is degenerate — treat as no config so
      // the resolver falls through to host-credentials cleanly.
      return null;
    }
    return {
      mode: raw.mode,
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
      savedAt: typeof raw.savedAt === "string" ? raw.savedAt : undefined,
    };
  } catch {
    return null;
  }
}

export interface WriteAuthConfigInput {
  mode: AuthConfigMode;
  /** Required when mode === "api-key". Trimmed before write. */
  apiKey?: string;
}

export type WriteAuthConfigResult =
  | { ok: true; status: AuthConfigStatus }
  | { ok: false; error: string };

/** Persist a config update. Atomic-ish: write to a tmp path, chmod 0600, rename. */
export function writeAuthConfig(input: WriteAuthConfigInput): WriteAuthConfigResult {
  if (input.mode !== "cli" && input.mode !== "api-key") {
    return { ok: false, error: `invalid mode: ${String(input.mode)}` };
  }

  const p = authConfigPath();
  ensureParentDir(p);

  let apiKey: string | undefined;
  if (input.mode === "api-key") {
    const k = input.apiKey?.trim();
    if (!k) return { ok: false, error: "apiKey is required when mode is api-key" };
    apiKey = k;
  }

  const next: AuthConfig = {
    mode: input.mode,
    ...(apiKey ? { apiKey } : {}),
    savedAt: new Date().toISOString(),
  };

  const tmp = `${p}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8" });
    chmodSync(tmp, 0o600);
    // rename = atomic replace on POSIX. writeFileSync above won't preserve
    // 0600 on the destination if we wrote in place, hence the dance.
    renameSync(tmp, p);
    chmodSync(p, 0o600);
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }

  return { ok: true, status: authConfigStatus() };
}

/** Remove the config file entirely. Falls back to today's resolution chain. */
export function deleteAuthConfig(): { removed: boolean } {
  const p = authConfigPath();
  if (!existsSync(p)) return { removed: false };
  unlinkSync(p);
  return { removed: true };
}

/** Masked status for the UI / API. NEVER includes the raw key. */
export function authConfigStatus(): AuthConfigStatus {
  const p = authConfigPath();
  const cfg = readAuthConfig();
  if (!cfg) {
    return { mode: null, keyHint: null, savedAt: null, path: p };
  }
  return {
    mode: cfg.mode,
    keyHint: cfg.mode === "api-key" ? keyHint(cfg.apiKey) : null,
    savedAt: cfg.savedAt ?? null,
    path: p,
  };
}

/** Diagnostic: returns true if the file exists with sensible permissions. */
export function authConfigFileMode(): { exists: boolean; mode: number | null } {
  const p = authConfigPath();
  if (!existsSync(p)) return { exists: false, mode: null };
  try {
    return { exists: true, mode: statSync(p).mode & 0o777 };
  } catch {
    return { exists: true, mode: null };
  }
}
