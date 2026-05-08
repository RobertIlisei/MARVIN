/**
 * Authentication for MARVIN's Claude CLI runtime.
 *
 * Detects which credential path is in play and returns the right env for a
 * Claude CLI subprocess. Supports three modes:
 *
 *   1. Host credentials — user ran `claude auth login`; CLI reads its own
 *      token from `~/.claude/`. Enable with `MARVIN_USE_HOST_CREDENTIALS=1`.
 *   2. OAuth token — set via `CLAUDE_CODE_OAUTH_TOKEN` or (if OAuth-shaped)
 *      via `ANTHROPIC_API_KEY`. Shape: `sk-ant-oat-*`.
 *   3. Console API key — `ANTHROPIC_API_KEY` with shape `sk-ant-api-*`
 *      (anything not matching OAuth).
 *
 * Design notes:
 *   - Only Claude CLI is supported (OpenRouter / direct Anthropic Messages API
 *     handled separately, elsewhere, if ever needed).
 *   - No OAuth refresh lockfile — a single-user workstation doesn't need a
 *     cross-process lock.
 *   - No deep probe on every health check.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readAuthConfig } from "./auth-config";

export type AuthMode = "host-credentials" | "oauth" | "api-key" | "none";

export interface AnthropicAuthStatus {
  mode: AuthMode;
  /** Credential masked for display (e.g. `sk-ant-api-xxx…abcd`). */
  credentialHint: string | null;
  /** Specific human-readable reason when `mode === "none"`. */
  error: string | null;
}

function trimEnv(name: string): string {
  const raw = process.env[name];
  if (raw == null) return "";
  let s = String(raw).trim();
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

function isOAuthToken(key: string): boolean {
  return /^sk-ant-oat/i.test(key);
}

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length < 12) return "***";
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}

/**
 * The Claude CLI stores its OAuth material in `~/.claude/` on Linux/Windows
 * and in the macOS Keychain on Darwin. If a user has run `claude auth login`,
 * the SDK will find and use those credentials on its own — no env vars needed.
 *
 * We detect this state with a best-effort heuristic so `/api/health` doesn't
 * report `mode: none` when the SDK is actually wired fine via host creds.
 * Keychain contents aren't readable without a prompt, so on macOS we fall
 * back to "CLI home directory exists with session history" as a proxy for
 * "this user has used Claude Code recently and is probably logged in".
 */
function hasHostCredentialsOnDisk(): boolean {
  const home = homedir();
  // Explicit credential files (Linux/Windows).
  const files = [
    join(home, ".claude", ".credentials.json"),
    join(home, ".claude", "auth.json"),
    join(home, ".config", "claude-code", "auth.json"),
  ];
  for (const p of files) {
    try {
      if (existsSync(p) && statSync(p).size > 0) return true;
    } catch {
      /* ignore */
    }
  }
  // macOS Keychain-backed install: we can only infer. Treat the presence of
  // the CLI state directory + recent history as "likely authenticated".
  if (process.platform === "darwin") {
    try {
      const history = join(home, ".claude", "history.jsonl");
      if (existsSync(history) && statSync(history).size > 0) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export function getAnthropicAuth(): AnthropicAuthStatus {
  // UI-managed override (Settings → Authentication). When the user has
  // explicitly chosen a mode in the macOS app, that choice wins over
  // every env-var path. mode === "cli" forces host-credentials regardless
  // of any ANTHROPIC_API_KEY hanging around in the shell environment.
  const cfg = readAuthConfig();
  if (cfg) {
    if (cfg.mode === "api-key" && cfg.apiKey) {
      return {
        mode: isOAuthToken(cfg.apiKey) ? "oauth" : "api-key",
        credentialHint: maskKey(cfg.apiKey),
        error: null,
      };
    }
    if (cfg.mode === "cli") {
      if (hasHostCredentialsOnDisk()) {
        return {
          mode: "host-credentials",
          credentialHint: "~/.claude (CLI-managed · selected in UI)",
          error: null,
        };
      }
      return {
        mode: "none",
        credentialHint: null,
        error:
          "UI selected 'Claude CLI', but no host credentials found. " +
          "Run `claude auth login`, or switch to 'Anthropic API key' in Settings.",
      };
    }
  }

  if (trimEnv("MARVIN_USE_HOST_CREDENTIALS") === "1") {
    return {
      mode: "host-credentials",
      credentialHint: "~/.claude (CLI-managed · opt-in)",
      error: null,
    };
  }

  const oauthEnv = trimEnv("CLAUDE_CODE_OAUTH_TOKEN");
  if (oauthEnv && isOAuthToken(oauthEnv)) {
    return {
      mode: "oauth",
      credentialHint: maskKey(oauthEnv),
      error: null,
    };
  }

  const apiEnv = trimEnv("ANTHROPIC_API_KEY");
  if (apiEnv) {
    if (isOAuthToken(apiEnv)) {
      return {
        mode: "oauth",
        credentialHint: maskKey(apiEnv),
        error: null,
      };
    }
    return {
      mode: "api-key",
      credentialHint: maskKey(apiEnv),
      error: null,
    };
  }

  if (hasHostCredentialsOnDisk()) {
    return {
      mode: "host-credentials",
      credentialHint: "~/.claude (CLI-managed · auto-detected)",
      error: null,
    };
  }

  return {
    mode: "none",
    credentialHint: null,
    error:
      "No credentials configured. Run `claude auth login`, or set " +
      "ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / MARVIN_USE_HOST_CREDENTIALS=1.",
  };
}

/**
 * Build the environment a Claude CLI subprocess should inherit.
 * Strips nesting markers and normalizes the key/token variables per mode.
 */
export function buildSubprocessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Remove nesting markers so the spawned CLI doesn't think it's a nested
  // Claude Code session and reject accordingly.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;

  const cfg = readAuthConfig();
  const status = getAnthropicAuth();
  switch (status.mode) {
    case "host-credentials":
      // The CLI will read its own token from disk. If the user picked
      // "Claude CLI" in the UI, also strip any ANTHROPIC_API_KEY /
      // CLAUDE_CODE_OAUTH_TOKEN that happens to be in the parent process
      // env so the CLI doesn't override the explicit UI choice.
      if (cfg?.mode === "cli") {
        delete env.ANTHROPIC_API_KEY;
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
      }
      return env;
    case "oauth": {
      // UI config wins, then env. OAuth tokens MUST go via
      // CLAUDE_CODE_OAUTH_TOKEN — Claude CLI rejects them via
      // ANTHROPIC_API_KEY ("Invalid API key").
      const token =
        (cfg?.mode === "api-key" ? cfg.apiKey : undefined) ||
        trimEnv("CLAUDE_CODE_OAUTH_TOKEN") ||
        trimEnv("ANTHROPIC_API_KEY");
      delete env.ANTHROPIC_API_KEY;
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
      return env;
    }
    case "api-key": {
      // UI config wins, then env.
      const key =
        (cfg?.mode === "api-key" ? cfg.apiKey : undefined) ||
        trimEnv("ANTHROPIC_API_KEY");
      env.ANTHROPIC_API_KEY = key;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      return env;
    }
    case "none":
      return env;
  }
}
