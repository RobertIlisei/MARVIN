/**
 * Fetch skills from Git repos (ADR-0039, phase A).
 *
 * Skills in the Claude ecosystem are ACQUIRED — a `SKILL.md` folder copied
 * out of a Git repo (the official `anthropics/skills`, a community repo, a
 * marketplace, or your own private repo) — not generated. MARVIN could only
 * install from its pinned bundle or AUTHOR a project-local skill; this adds
 * the missing "fetch an existing skill from a URL" path.
 *
 * Clone + copy ONLY — nothing from the repo is executed (a SKILL.md can
 * carry scripts; running them is the user's choice when they later invoke
 * the skill, not ours at install). The endpoint that calls this is CSRF-
 * guarded and user-initiated.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

export type SkillScope = "user-global" | "project-local";

export interface SkillCandidate {
  name: string;
  description: string;
}

export interface MarketplacePlugin {
  name: string;
  displayName?: string;
  description?: string;
}

export interface AddSkillResult {
  ok: boolean;
  error?: string;
  /** Installed skills (when something was installed). */
  installed?: Array<{ name: string; scope: SkillScope; path: string }>;
  /** When the repo holds >1 skill and none was selected — the pick-list
   *  to show the user (nothing installed yet). */
  available?: SkillCandidate[];
  /** When the URL is a plugin marketplace (ADR-0039 phase B) and no plugin
   *  was chosen — the plugin list to pick from (nothing installed yet). */
  marketplace?: { name: string; plugins: MarketplacePlugin[] };
}

interface ParsedGitUrl {
  cloneUrl: string;
  branch?: string;
  subpath?: string;
}

/** Parse a user-supplied Git URL. Handles GitHub `tree`/`blob` sub-path web
 *  URLs (install just that folder), plain GitHub web URLs, and raw clone
 *  URLs (ssh / https / git). Returns null for anything unrecognised. */
export function parseGitUrl(raw: string): ParsedGitUrl | null {
  const url = raw.trim();
  // GitHub web URL pointing at a sub-path: …/tree/<branch>/<path> or /blob/…
  const sub = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:tree|blob)\/([^/]+)\/(.+)$/,
  );
  if (sub) {
    return {
      cloneUrl: `https://github.com/${sub[1]}/${sub[2]}.git`,
      branch: sub[3],
      subpath: (sub[4] ?? "").replace(/\/+$/, ""),
    };
  }
  // Plain GitHub web URL → clone the whole repo.
  const repo = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (repo) return { cloneUrl: `https://github.com/${repo[1]}/${repo[2]}.git` };
  // Any other raw git URL (ssh / https / git) — pass straight to `git clone`.
  if (/^(git@[^:]+:|https?:\/\/|git:\/\/).+/.test(url)) return { cloneUrl: url };
  // A local filesystem path (a private/local skill repo) or file:// URL.
  if (url.startsWith("file://") || url.startsWith("/")) return { cloneUrl: url };
  return null;
}

function parseFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end < 0) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of text.slice(4, end).split("\n")) {
    const m = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = (m[2] ?? "").trim().replace(/^['"](.*)['"]$/, "$1");
    if (key === "name" || key === "description") out[key] = val;
  }
  return out;
}

interface DiscoveredSkill {
  name: string;
  description: string;
  dir: string;
}

/** Walk a directory tree (depth-limited) for folders containing a valid
 *  `SKILL.md`. A skill folder is a leaf — we don't descend into its own
 *  subtree (supporting files belong to it). Exported for tests. */
export function discoverSkills(root: string, maxDepth = 3): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  const walk = (dir: string, depth: number): void => {
    const skillMd = join(dir, "SKILL.md");
    if (existsSync(skillMd)) {
      try {
        const fm = parseFrontmatter(readFileSync(skillMd, "utf-8"));
        if (fm.description || fm.name) {
          out.push({ name: fm.name ?? basename(dir), description: fm.description ?? "", dir });
        }
      } catch {
        /* unreadable — skip */
      }
      return; // leaf
    }
    if (depth >= maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) walk(join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function installCandidates(
  candidates: DiscoveredSkill[],
  target: string,
  scope: SkillScope,
): Array<{ name: string; scope: SkillScope; path: string }> {
  mkdirSync(target, { recursive: true });
  const installed: Array<{ name: string; scope: SkillScope; path: string }> = [];
  for (const c of candidates) {
    const dest = join(target, sanitizeName(c.name));
    rmSync(dest, { recursive: true, force: true }); // idempotent re-install
    cpSync(c.dir, dest, { recursive: true });
    installed.push({ name: c.name, scope, path: join(dest, "SKILL.md") });
  }
  return installed;
}

// ── Marketplace support (ADR-0039 phase B) ─────────────────────────────

interface PluginEntry {
  name: string;
  displayName?: string;
  description?: string;
  source: string | Record<string, unknown>;
}

/** Read a `.claude-plugin/marketplace.json` if `dir` is a marketplace. */
function readMarketplace(dir: string): { name: string; plugins: PluginEntry[] } | null {
  const p = join(dir, ".claude-plugin", "marketplace.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf-8")) as { name?: string; plugins?: PluginEntry[] };
    if (Array.isArray(j.plugins)) {
      return { name: typeof j.name === "string" ? j.name : "marketplace", plugins: j.plugins };
    }
  } catch {
    /* malformed — not a usable marketplace */
  }
  return null;
}

function cloneInto(cloneUrl: string, ref: string | undefined, tmps: string[]): string | null {
  const t = mkdtempSync(join(tmpdir(), "marvin-plug-"));
  tmps.push(t);
  const args = ["clone", "--depth=1"];
  if (ref) args.push("--branch", ref);
  args.push(cloneUrl, t);
  try {
    execFileSync("git", args, { encoding: "utf-8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
    return t;
  } catch {
    return null;
  }
}

/** Resolve a plugin entry's `source` to a local directory, cloning a
 *  sub-repo if needed (tracked in `tmps` for cleanup). */
function resolvePluginDir(
  repoRoot: string,
  entry: PluginEntry,
  tmps: string[],
): { dir?: string; error?: string } {
  const src = entry.source;
  if (typeof src === "string") {
    if (!src.startsWith("./")) return { error: `plugin '${entry.name}' has an unsupported string source.` };
    return { dir: join(repoRoot, src) };
  }
  if (src && typeof src === "object") {
    const kind = (src as { source?: string }).source;
    const ref = typeof (src as { ref?: string }).ref === "string" ? (src as { ref?: string }).ref : undefined;
    if (kind === "github" && typeof (src as { repo?: string }).repo === "string") {
      const dir = cloneInto(`https://github.com/${(src as { repo: string }).repo}.git`, ref, tmps);
      return dir ? { dir } : { error: `clone of plugin '${entry.name}' failed.` };
    }
    if (kind === "url" && typeof (src as { url?: string }).url === "string") {
      const dir = cloneInto((src as { url: string }).url, ref, tmps);
      return dir ? { dir } : { error: `clone of plugin '${entry.name}' failed.` };
    }
    if (
      kind === "git-subdir" &&
      typeof (src as { url?: string }).url === "string" &&
      typeof (src as { path?: string }).path === "string"
    ) {
      const dir = cloneInto((src as { url: string }).url, ref, tmps);
      return dir ? { dir: join(dir, (src as { path: string }).path) } : { error: `clone of plugin '${entry.name}' failed.` };
    }
  }
  return {
    error: `plugin '${entry.name}' uses an unsupported source type (supported: relative path, github, url, git-subdir).`,
  };
}

function targetDir(scope: SkillScope, workDir?: string): string | null {
  if (scope === "project-local") {
    return workDir ? join(workDir, ".marvin", "skills") : null;
  }
  return join(homedir(), ".claude", "skills");
}

/**
 * Clone a repo and install one or more of its skills. Multi-skill repos
 * with no `only` selection return the candidate list instead of installing.
 */
export function addSkillFromGit(input: {
  url: string;
  scope: SkillScope;
  workDir?: string;
  only?: string[];
  /** Marketplace flow (phase B): the plugin to install from a marketplace URL. */
  plugin?: string;
}): AddSkillResult {
  const parsed = parseGitUrl(input.url);
  if (!parsed) return { ok: false, error: "Not a recognised Git URL." };

  const target = targetDir(input.scope, input.workDir);
  if (!target) return { ok: false, error: "project-local scope requires a workDir." };

  const tmps: string[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "marvin-skill-"));
  tmps.push(tmp);
  try {
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

    // Phase B — is this a plugin marketplace?
    const mp = readMarketplace(root);
    if (mp) {
      if (!input.plugin) {
        // Hand back the plugin list to choose from.
        return {
          ok: true,
          marketplace: {
            name: mp.name,
            plugins: mp.plugins.map((p) => ({
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
      if (resolved.error || !resolved.dir) {
        return { ok: false, error: resolved.error ?? "could not resolve the plugin." };
      }
      if (!existsSync(resolved.dir)) {
        return { ok: false, error: `plugin '${input.plugin}' directory not found in the marketplace.` };
      }
      const pluginSkills = discoverSkills(resolved.dir);
      if (pluginSkills.length === 0) {
        return { ok: false, error: `plugin '${input.plugin}' has no SKILL.md skills (it may provide commands/agents/MCP only).` };
      }
      // A plugin is a curated bundle — install all its skills (or a subset
      // if `only` was given).
      const want = input.only && input.only.length > 0 ? new Set(input.only) : null;
      const chosen = want ? pluginSkills.filter((s) => want.has(s.name)) : pluginSkills;
      return { ok: true, installed: installCandidates(chosen, target, input.scope) };
    }

    // Phase A — a plain skill repo.
    const candidates = discoverSkills(root);
    if (candidates.length === 0) {
      return { ok: false, error: "No SKILL.md found in that repository / path." };
    }

    let toInstall = candidates;
    if (input.only && input.only.length > 0) {
      const want = new Set(input.only);
      toInstall = candidates.filter((c) => want.has(c.name));
      if (toInstall.length === 0) {
        return { ok: false, error: "None of the selected skills were found in the repo." };
      }
    } else if (candidates.length > 1) {
      return {
        ok: true,
        available: candidates.map((c) => ({ name: c.name, description: c.description })),
      };
    }
    return { ok: true, installed: installCandidates(toInstall, target, input.scope) };
  } finally {
    for (const t of tmps) rmSync(t, { recursive: true, force: true });
  }
}
