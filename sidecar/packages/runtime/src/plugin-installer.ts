/**
 * Install a FULL Claude Code plugin into `~/.claude/plugins/` (ADR-0053
 * Phase 3).
 *
 * `skill-installer.ts` (ADR-0039 phase B) can already extract a plugin's
 * *skills* into `~/.claude/skills/`. This installs the *whole plugin* — copied
 * into the plugin cache and registered in `installed_plugins.json` — so it is
 * discoverable by the plugin loader (`plugin-loader.ts`) exactly like a plugin
 * the user installed through the Claude Code `/plugin` UI. Discovery is shared,
 * so a plugin installed here also shows up in Claude Code, and vice-versa.
 *
 * Clone + copy ONLY — nothing from the repo is executed at install (a plugin
 * can carry hooks/scripts; running them is a later, gated choice — and v1 of
 * the loader strips hooks/agents anyway). The route that calls this is
 * CSRF-guarded and user-initiated.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { authorName } from "./plugin-loader";
import {
  cloneInto,
  type MarketplacePlugin,
  parseGitUrl,
  type PluginEntry,
  readMarketplace,
  resolvePluginDir,
} from "./skill-installer";

export interface InstallPluginResult {
  ok: boolean;
  error?: string;
  /** Set when a plugin was installed. */
  installed?: { name: string; key: string; installPath: string; version: string };
  /** Set when the URL is a marketplace and no plugin was chosen — the
   *  pick-list to show the user (nothing installed yet). */
  marketplace?: { name: string; plugins: MarketplacePlugin[] };
}

/** `~/.claude/plugins/`. */
function pluginsRoot(): string {
  return join(homedir(), ".claude", "plugins");
}

function installedPluginsPath(): string {
  return join(pluginsRoot(), "installed_plugins.json");
}

interface InstalledEntry {
  scope: string;
  installPath: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
}

interface InstalledPluginsFile {
  version?: number;
  plugins?: Record<string, InstalledEntry[]>;
}

/**
 * Pure registry merge — insert/replace the user-scope entry for `key` in the
 * parsed `installed_plugins.json` object. Exported for tests (the FS wrapper
 * below is the untestable-without-HOME part). Preserves other scopes' entries
 * and other plugins untouched.
 */
export function upsertInstalledPlugin(
  file: InstalledPluginsFile,
  key: string,
  entry: InstalledEntry,
): InstalledPluginsFile {
  const next: InstalledPluginsFile = {
    version: file.version ?? 2,
    plugins: { ...(file.plugins ?? {}) },
  };
  const existing = (next.plugins![key] ?? []).filter((e) => e.scope !== entry.scope);
  next.plugins![key] = [...existing, entry];
  return next;
}

function registerInstalledPlugin(key: string, installPath: string, version: string): void {
  let file: InstalledPluginsFile = { version: 2, plugins: {} };
  try {
    file = JSON.parse(readFileSync(installedPluginsPath(), "utf-8")) as InstalledPluginsFile;
  } catch {
    /* first install / unreadable → start fresh */
  }
  const now = new Date().toISOString();
  const merged = upsertInstalledPlugin(file, key, {
    scope: "user",
    installPath,
    version,
    installedAt: now,
    lastUpdated: now,
  });
  mkdirSync(pluginsRoot(), { recursive: true });
  writeFileSync(installedPluginsPath(), JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

/** Read a plugin dir's manifest name + version (best-effort defaults). */
function readPluginManifest(dir: string): { name: string; version: string } {
  try {
    const m = JSON.parse(
      readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf-8"),
    ) as { name?: string; version?: string };
    return { name: m.name ?? "plugin", version: m.version ?? "unknown" };
  } catch {
    return { name: "plugin", version: "unknown" };
  }
}

function sanitize(seg: string): string {
  return seg.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "x";
}

/** Copy a resolved plugin dir into the cache and register it. Returns the
 *  install record. */
function installResolvedPlugin(
  pluginDir: string,
  marketName: string,
  pluginName: string,
): InstallPluginResult {
  if (!existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))) {
    return {
      ok: false,
      error: `'${pluginName}' has no .claude-plugin/plugin.json — not a valid plugin.`,
    };
  }
  const { name, version } = readPluginManifest(pluginDir);
  const dest = join(
    pluginsRoot(),
    "cache",
    sanitize(marketName),
    sanitize(pluginName),
    sanitize(version),
  );
  rmSync(dest, { recursive: true, force: true }); // idempotent re-install
  mkdirSync(dest, { recursive: true });
  cpSync(pluginDir, dest, { recursive: true });

  const key = `${pluginName}@${marketName}`;
  registerInstalledPlugin(key, dest, version);
  return { ok: true, installed: { name, key, installPath: dest, version } };
}

/**
 * Install a plugin from a Git URL. If the URL is a marketplace and no
 * `plugin` is chosen, returns the marketplace pick-list. If it's a bare plugin
 * repo (a root `.claude-plugin/plugin.json`), installs it directly under a
 * synthetic marketplace name derived from the repo.
 */
export function installPluginFromGit(input: { url: string; plugin?: string }): InstallPluginResult {
  const parsed = parseGitUrl(input.url);
  if (!parsed) return { ok: false, error: "Not a recognised Git URL." };

  const tmps: string[] = [];
  try {
    const tmp = mkdtempSync(join(tmpdir(), "marvin-fullplug-"));
    tmps.push(tmp);
    const args = ["clone", "--depth=1"];
    if (parsed.branch) args.push("--branch", parsed.branch);
    args.push(parsed.cloneUrl, tmp);
    try {
      execFileSync("git", args, {
        encoding: "utf-8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n").slice(-2).join(" ") : String(e);
      return { ok: false, error: `git clone failed: ${msg}` };
    }

    const root = parsed.subpath ? join(tmp, parsed.subpath) : tmp;
    if (!existsSync(root)) {
      return { ok: false, error: `path '${parsed.subpath}' not found in the repository.` };
    }

    // Marketplace?
    const mp = readMarketplace(root);
    if (mp) {
      if (!input.plugin) {
        return {
          ok: true,
          marketplace: {
            name: mp.name,
            plugins: mp.plugins.map((p: PluginEntry) => ({
              name: p.name,
              ...(p.displayName ? { displayName: p.displayName } : {}),
              ...(p.description ? { description: p.description } : {}),
            })),
          },
        };
      }
      const entry = mp.plugins.find((p) => p.name === input.plugin);
      if (!entry) return { ok: false, error: `plugin '${input.plugin}' is not in this marketplace.` };
      const resolved = resolvePluginDir(root, entry, tmps);
      if (resolved.error || !resolved.dir || !existsSync(resolved.dir)) {
        return { ok: false, error: resolved.error ?? "could not resolve the plugin." };
      }
      return installResolvedPlugin(resolved.dir, mp.name, entry.name);
    }

    // Bare plugin repo — a root manifest, no marketplace.
    if (existsSync(join(root, ".claude-plugin", "plugin.json"))) {
      const { name } = readPluginManifest(root);
      // Synthetic marketplace name from the clone URL host/repo, so the key is
      // stable + human-readable ("name@owner-repo").
      const market = deriveMarketName(parsed.cloneUrl);
      return installResolvedPlugin(root, market, name);
    }

    return {
      ok: false,
      error:
        "No marketplace.json and no root .claude-plugin/plugin.json — that URL isn't a plugin or a plugin marketplace.",
    };
  } finally {
    for (const t of tmps) rmSync(t, { recursive: true, force: true });
  }
}

/** A stable, readable marketplace name for a bare plugin repo, e.g.
 *  `https://github.com/acme/tools.git` → `acme-tools`. */
export function deriveMarketName(cloneUrl: string): string {
  const m = cloneUrl.match(/([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (m) return sanitize(`${m[1]}-${m[2]}`);
  return "local";
}

// ── Marketplace catalog browse (ADR-0053 follow-up) ─────────────────────────
//
// The Claude Code `/plugin` UI doesn't just list installed plugins — it browses
// the CATALOGS of the user's known marketplaces (`known_marketplaces.json`,
// each already cloned under `~/.claude/plugins/marketplaces/`). The official
// marketplace alone carries ~270 plugins. Reading those local clones needs no
// network; only installing an external-source plugin does.

export interface CatalogPlugin {
  marketplace: string;
  name: string;
  displayName?: string;
  description?: string;
  category?: string;
  /** Catalog author name — the provenance signal ("Anthropic" vs third party).
   *  Absent when the marketplace entry doesn't declare one. */
  author?: string;
  /** True when a plugin with this bare name is already installed (any
   *  marketplace — the enable toggle works on bare names, so same-named
   *  plugins are one logical slot). */
  installed: boolean;
}

function knownMarketplacesPath(): string {
  return join(pluginsRoot(), "known_marketplaces.json");
}

/** `known_marketplaces.json` → [{name, location}] for entries whose clone
 *  exists on disk. Never throws. */
export function readKnownMarketplaces(): Array<{ name: string; location: string }> {
  try {
    const j = JSON.parse(readFileSync(knownMarketplacesPath(), "utf-8")) as Record<
      string,
      { installLocation?: string }
    >;
    return Object.entries(j)
      .filter(([, v]) => typeof v?.installLocation === "string" && existsSync(v.installLocation!))
      .map(([name, v]) => ({ name, location: v.installLocation! }));
  } catch {
    return [];
  }
}

/**
 * Pure catalog assembly — exported for tests. Marks entries installed by bare
 * name against the installed registry's keys, and keeps marketplace order /
 * alphabetical plugin order stable for the UI.
 */
export function buildCatalog(
  markets: Array<{ name: string; plugins: PluginEntry[] }>,
  installedKeys: Iterable<string>,
): CatalogPlugin[] {
  const installedNames = new Set(
    [...installedKeys].map((k) => k.split("@")[0]).filter(Boolean),
  );
  const out: CatalogPlugin[] = [];
  for (const m of markets) {
    for (const p of m.plugins) {
      const author = authorName(p.author);
      out.push({
        marketplace: m.name,
        name: p.name,
        ...(p.displayName ? { displayName: p.displayName } : {}),
        ...(p.description ? { description: p.description } : {}),
        ...(p.category ? { category: p.category } : {}),
        ...(author ? { author } : {}),
        installed: installedNames.has(p.name),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read every known marketplace's local catalog + the installed registry and
 *  assemble the browseable list. Local-JSON only — no network. */
export function listMarketplaceCatalog(): CatalogPlugin[] {
  const markets: Array<{ name: string; plugins: PluginEntry[] }> = [];
  for (const m of readKnownMarketplaces()) {
    const mp = readMarketplace(m.location);
    if (mp) markets.push({ name: m.name, plugins: mp.plugins });
  }
  let installedKeys: string[] = [];
  try {
    const f = JSON.parse(readFileSync(installedPluginsPath(), "utf-8")) as InstalledPluginsFile;
    installedKeys = Object.keys(f.plugins ?? {});
  } catch {
    /* none installed */
  }
  return buildCatalog(markets, installedKeys);
}

/**
 * Install a plugin picked from a KNOWN marketplace's catalog. Resolves from
 * the local marketplace clone — relative-path plugins copy straight out of the
 * clone (no network); external sources (github / url / git-subdir) shallow-clone
 * just that plugin's repo.
 */
export function installFromKnownMarketplace(input: {
  marketplace: string;
  plugin: string;
}): InstallPluginResult {
  const market = readKnownMarketplaces().find((m) => m.name === input.marketplace);
  if (!market) {
    return { ok: false, error: `marketplace '${input.marketplace}' is not in known_marketplaces.json.` };
  }
  const mp = readMarketplace(market.location);
  if (!mp) return { ok: false, error: `marketplace '${input.marketplace}' has no readable catalog.` };
  const entry = mp.plugins.find((p) => p.name === input.plugin);
  if (!entry) return { ok: false, error: `plugin '${input.plugin}' is not in that marketplace.` };

  const tmps: string[] = [];
  try {
    const resolved = resolvePluginDir(market.location, entry, tmps);
    if (resolved.error || !resolved.dir || !existsSync(resolved.dir)) {
      return { ok: false, error: resolved.error ?? "could not resolve the plugin." };
    }
    return installResolvedPlugin(resolved.dir, input.marketplace, entry.name);
  } finally {
    for (const t of tmps) rmSync(t, { recursive: true, force: true });
  }
}
