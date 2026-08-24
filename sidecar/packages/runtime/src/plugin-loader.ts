/**
 * Claude Code plugins in MARVIN — opt-in local-plugin loader (ADR-0053).
 *
 * MARVIN runs the Agent SDK in isolation mode (no `settingSources`), so plugins
 * installed via the Claude Code `/plugin` UI — whose *enablement* lives in the
 * settings family — don't load. The SDK's `plugins: [{ type:'local', path }]`
 * option loads a plugin's contributions WITHOUT `settingSources` (and thus
 * without the settings/hook/CLAUDE.md bleed we deliberately avoid). This module
 * turns installed + per-project-enabled plugins into that array.
 *
 * Discovery source is `~/.claude/plugins/` — the SAME registry the Claude Code
 * UI writes — so a plugin installed there is immediately *available* to MARVIN
 * (Golden Rule: the user's tools stay the user's). Availability ≠ active: a
 * plugin loads into a turn only when listed in `<workDir>/.marvin/plugins.json`
 * (mirrors ADR-0037's `skills.json`). Default empty → nothing auto-loads.
 *
 * Contribution scope: skills + slash commands + MCP servers (ADR-0053) +
 * **agents, read-only** (ADR-0054). Plugin **hooks** stay stripped — they
 * interpose arbitrary code on MARVIN's tool flow and have no read-only
 * containment (ADR-0054 §2, deliberately not "pending"). Because the SDK's
 * local-plugin loader is all-or-nothing per dir, we honour that cut by
 * pointing the SDK at a SANITISED STAGED COPY of the plugin under
 * `<workDir>/.marvin/plugins-stage/<name>/` with `hooks/` (and the manifest
 * `hooks` field) removed. Plugin agents are contained mechanically, not by
 * staging: dispatch of an unknown `subagent_type` classifies `confirm`, and
 * every call from a spawned agent carries an SDK `agentID` the gate collapses
 * to read-only (ADR-0030 invariant). Plugin MCP servers are NOT loaded by the
 * local-plugin path (the SDK loads commands/agents/skills/hooks only), so we
 * read the manifest's `mcpServers` and return them for the caller to merge
 * into `options.mcpServers` — where the ADR-0053 gate change routes their
 * tools through `confirm`.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  readAllPluginProvenance,
  type SourceInfo,
  toSourceInfo,
} from "./install-provenance";

import { validateProjectCwd } from "./projects";

/** Minimal MCP server config shape we pass through to the SDK. Kept loose to
 *  avoid coupling this module to the SDK's exact union; the caller merges it
 *  into a `Record<string, McpServerConfig>` that is later cast to `Options`. */
export type PluginMcpServerConfig = Record<string, unknown>;

export interface LoadedPlugins {
  /** `{ type:'local', path }` entries for the SDK `plugins:` option. */
  plugins: Array<{ type: "local"; path: string }>;
  /** Plugin-declared MCP servers, keyed by a namespaced server key. */
  mcpServers: Record<string, PluginMcpServerConfig>;
  /** Names of plugins actually staged + loaded this turn. */
  loaded: string[];
  /** Enabled-but-unusable plugins, with why (not installed / staging failed). */
  skipped: Array<{ name: string; reason: string }>;
}

const EMPTY: LoadedPlugins = { plugins: [], mcpServers: {}, loaded: [], skipped: [] };

interface InstalledPluginEntry {
  scope?: string;
  installPath?: string;
  version?: string;
}

interface InstalledPluginsFile {
  version?: number;
  plugins?: Record<string, InstalledPluginEntry[]>;
}

interface PluginsJson {
  /** Plugin names the user has activated for this project. Matched against the
   *  installed registry by full key ("name@marketplace") OR bare "name". */
  enabled?: string[];
}

function installedPluginsPath(): string {
  return join(homedir(), ".claude", "plugins", "installed_plugins.json");
}

function pluginsJsonPath(workDir: string): string {
  return join(workDir, ".marvin", "plugins.json");
}

/** The user's per-project enabled set (empty array when unset/corrupt). */
export function readEnabledPlugins(workDir: string): string[] {
  try {
    const j = JSON.parse(readFileSync(pluginsJsonPath(workDir), "utf-8")) as PluginsJson;
    if (Array.isArray(j.enabled)) {
      return j.enabled.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* absent / corrupt → nothing enabled */
  }
  return [];
}

/** Persist the per-project enabled set (Plugins pane toggle). Deduped + sorted.
 *  CSRF is the caller's concern; this is pure FS. */
export function setEnabledPlugins(workDir: string, enabled: string[]): void {
  mkdirSync(join(workDir, ".marvin"), { recursive: true });
  const payload: PluginsJson = { enabled: [...new Set(enabled)].sort() };
  writeFileSync(pluginsJsonPath(workDir), JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

/** A discovered plugin + a summary of what it would contribute, for the UI. */
export interface PluginSummary {
  /** Full registry key ("honeycomb@honeycomb-plugins"). */
  key: string;
  /** Bare name ("honeycomb") — what the toggle stores + shows. */
  name: string;
  /** The marketplace the plugin came from (key suffix). */
  marketplace?: string;
  /** Manifest author name — the provenance signal ("Anthropic", "Honeycomb"). */
  author?: string;
  version?: string;
  description?: string;
  /** Skill dir names bundled by the plugin (loaded in v1). */
  skills: string[];
  /** Slash-command names bundled (loaded in v1). */
  commands: string[];
  /** Subagent names bundled — loaded READ-ONLY, dispatch confirm-gated
   *  (ADR-0054). */
  agents: string[];
  /** True if the plugin declares an MCP server (loaded + gated). */
  hasMcp: boolean;
  /** True if the plugin ships hooks (never loaded — ADR-0054 §2). */
  hasHooks: boolean;
  /** True when this plugin is currently enabled for the project. */
  enabled: boolean;
  /** Where MARVIN installed this from, when it installed it (ADR-0071).
   *  Absent for plugins installed through the Claude Code `/plugin` UI —
   *  those are not ours to update. */
  source?: SourceInfo;
}

/**
 * List installed plugins with a contribution summary and per-project enabled
 * state — the read model behind the Plugins pane (ADR-0053 Phase 2) and the
 * `/api/plugins` route. Never throws; a plugin whose dir is unreadable is
 * summarised as best-effort (empty contribution lists).
 */
export function listInstalledPlugins(workDir: string): PluginSummary[] {
  const enabled = new Set(readEnabledPlugins(workDir));
  const seen = new Set<string>();
  const out: PluginSummary[] = [];
  const provenance = readAllPluginProvenance();

  let file: InstalledPluginsFile;
  try {
    file = JSON.parse(readFileSync(installedPluginsPath(), "utf-8")) as InstalledPluginsFile;
  } catch {
    return out;
  }
  for (const [key, entries] of Object.entries(file.plugins ?? {})) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const entry =
      entries.find((e) => e.scope === "user" && e.installPath && existsSync(e.installPath)) ??
      entries.find((e) => e.installPath && existsSync(e.installPath));
    if (!entry?.installPath) continue;
    const name = key.split("@")[0] || key;
    if (seen.has(name)) continue;
    seen.add(name);

    const manifest = readManifest(entry.installPath);
    const marketplace = key.includes("@") ? key.split("@").slice(1).join("@") : undefined;
    out.push({
      key,
      name,
      ...(marketplace ? { marketplace } : {}),
      ...(authorName(manifest.author) ? { author: authorName(manifest.author) } : {}),
      version: entry.version ?? (manifest.version as string | undefined),
      description: manifest.description as string | undefined,
      skills: listDirNames(join(entry.installPath, "skills")),
      commands: listCommandNames(join(entry.installPath, "commands")),
      agents: listCommandNames(join(entry.installPath, "agents")),
      hasMcp: Object.keys(readPluginMcpDeclarations(entry.installPath)).length > 0,
      hasHooks:
        existsSync(join(entry.installPath, "hooks")) || "hooks" in manifest,
      // A plugin is enabled if either its bare name or full key is listed.
      enabled: enabled.has(name) || enabled.has(key),
      ...(toSourceInfo(provenance[key] ?? null)
        ? { source: toSourceInfo(provenance[key] ?? null) }
        : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Extract a display author from a manifest/catalog `author` value, which may
 *  be a string or `{ name, email?, url? }`. Exported for the catalog builder. */
export function authorName(author: unknown): string | undefined {
  if (typeof author === "string" && author.trim()) return author.trim();
  if (author && typeof author === "object" && !Array.isArray(author)) {
    const n = (author as { name?: unknown }).name;
    if (typeof n === "string" && n.trim()) return n.trim();
  }
  return undefined;
}

function readManifest(srcPath: string): Record<string, unknown> {
  try {
    return JSON.parse(
      readFileSync(join(srcPath, ".claude-plugin", "plugin.json"), "utf-8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Immediate sub-directory names (used for `skills/`). */
function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

/** `*.md` basenames (used for `commands/` and `agents/`). */
function listCommandNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".md"))
      .map((n) => n.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/** Read `~/.claude/plugins/installed_plugins.json` into a name→installPath map.
 *  Registers both the full key ("honeycomb@market") and the bare name
 *  ("honeycomb") so `plugins.json` can list either. Never throws. */
export function discoverInstalledPlugins(): Map<string, string> {
  const out = new Map<string, string>();
  let file: InstalledPluginsFile;
  try {
    file = JSON.parse(readFileSync(installedPluginsPath(), "utf-8")) as InstalledPluginsFile;
  } catch {
    return out;
  }
  const plugins = file.plugins ?? {};
  for (const [key, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    // Prefer a user-scope entry; fall back to the first with a live installPath.
    const entry =
      entries.find((e) => e.scope === "user" && e.installPath && existsSync(e.installPath)) ??
      entries.find((e) => e.installPath && existsSync(e.installPath));
    if (!entry?.installPath) continue;
    out.set(key, entry.installPath);
    const bare = key.split("@")[0];
    if (bare && !out.has(bare)) out.set(bare, entry.installPath);
  }
  return out;
}

/** Directory names inside a plugin we refuse to load (tool-flow safety —
 *  ADR-0054 §2). Stripped from the staged copy. `agents/` is NOT stripped:
 *  plugin agents load read-only under the ADR-0030 invariant (ADR-0054 §1). */
const STRIPPED_DIRS = ["hooks"];

/**
 * Resolve the plugins to load for a turn. Returns `EMPTY` for a non-project cwd
 * or when nothing is enabled — the caller then behaves exactly as pre-ADR-0053.
 */
export function loadEnabledPlugins(workDir: string): LoadedPlugins {
  const valid = validateProjectCwd(workDir);
  if (!valid.ok) return EMPTY;

  const enabled = readEnabledPlugins(workDir);
  if (enabled.length === 0) return EMPTY;

  const installed = discoverInstalledPlugins();
  const result: LoadedPlugins = { plugins: [], mcpServers: {}, loaded: [], skipped: [] };

  const stageRoot = join(workDir, ".marvin", "plugins-stage");

  for (const name of enabled) {
    const srcPath = installed.get(name);
    if (!srcPath) {
      result.skipped.push({ name, reason: "not installed in ~/.claude/plugins" });
      continue;
    }
    const bare = name.split("@")[0] || name;
    const staged = join(stageRoot, bare);
    try {
      stageSanitisedPlugin(srcPath, staged);
    } catch (e) {
      result.skipped.push({ name, reason: `staging failed: ${(e as Error).message}` });
      continue;
    }
    result.plugins.push({ type: "local", path: staged });
    mergePluginMcpServers(srcPath, bare, result.mcpServers);
    result.loaded.push(name);
  }

  return result;
}

/**
 * Copy `srcPath` → `dest`, minus `hooks/`, and with the manifest's `hooks`
 * field removed (ADR-0054: agents stay, hooks never load). Idempotent: the
 * staged dir is rebuilt each call (plugin updates flow through; stale files
 * don't accumulate). The staged tree lives under `.marvin/` so it's
 * gitignore-adjacent project scratch, not committed. Exported for tests.
 */
export function stageSanitisedPlugin(srcPath: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(srcPath, dest, {
    recursive: true,
    filter: (src) => {
      for (const d of STRIPPED_DIRS) {
        if (src.endsWith(`/${d}`) || src.includes(`/${d}/`)) return false;
      }
      return true;
    },
  });
  // Strip `hooks` from the staged manifest so nothing re-registers them.
  const manifestPath = join(dest, ".claude-plugin", "plugin.json");
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
      if ("hooks" in m) {
        delete m.hooks;
        writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n", "utf-8");
      }
    } catch {
      /* leave a malformed manifest as-is; the SDK will surface its own error */
    }
  }
}

/**
 * Read a plugin's declared MCP servers (manifest `mcpServers` field, or a root
 * `.mcp.json`) and merge them into `into`, namespaced by the plugin name so the
 * ADR-0053 gate sees `mcp__<plugin>__<tool>` and routes it through `confirm`.
 * Best-effort — a plugin with no MCP declaration contributes nothing here.
 */
function mergePluginMcpServers(
  srcPath: string,
  pluginName: string,
  into: Record<string, PluginMcpServerConfig>,
): void {
  const declared = readPluginMcpDeclarations(srcPath);
  for (const [serverName, cfg] of Object.entries(declared)) {
    // Prefer the plugin's own server name; namespace-collide-safe within MARVIN
    // because our in-process keys are `marvin-*`.
    const key = serverName || pluginName;
    if (!into[key]) into[key] = cfg;
  }
}

/**
 * A value only counts as an MCP server config if it has the minimum shape the
 * SDK can actually start: a `command` (stdio) or a `url` (http / sse). This is
 * the boundary filter that keeps arbitrary manifest objects (`author`,
 * `keywords`, …) OUT of `options.mcpServers` — passing those to the SDK broke
 * the whole session (2026-07-23 regression: 9 enabled plugins × garbage
 * entries → turns stopped responding).
 */
function looksLikeServerConfig(v: unknown): v is PluginMcpServerConfig {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.command === "string" || typeof o.url === "string";
}

/**
 * Read a plugin's declared MCP servers. The manifest is consulted ONLY for an
 * explicit `mcpServers` field — never treated as a server map itself. A root
 * `.mcp.json` may be `{ mcpServers: {...} }` or a bare name→config map. Every
 * entry must pass `looksLikeServerConfig`. Exported for tests.
 */
export function readPluginMcpDeclarations(
  srcPath: string,
): Record<string, PluginMcpServerConfig> {
  // 1) manifest `mcpServers` — explicit field only, no fallback.
  const manifest = readJsonObject(join(srcPath, ".claude-plugin", "plugin.json"));
  const fromManifest = filterServerConfigs(manifest?.mcpServers);
  if (Object.keys(fromManifest).length > 0) return fromManifest;
  // 2) a root `.mcp.json` — `{ mcpServers: {...} }` or a bare map.
  const mcpJson = readJsonObject(join(srcPath, ".mcp.json"));
  if (!mcpJson) return {};
  const explicit = filterServerConfigs(mcpJson.mcpServers);
  if (Object.keys(explicit).length > 0) return explicit;
  return filterServerConfigs(mcpJson);
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
  } catch {
    /* absent / malformed */
  }
  return null;
}

function filterServerConfigs(map: unknown): Record<string, PluginMcpServerConfig> {
  const out: Record<string, PluginMcpServerConfig> = {};
  if (!map || typeof map !== "object" || Array.isArray(map)) return out;
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    if (looksLikeServerConfig(v)) out[k] = v;
  }
  return out;
}
