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
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import {
  buildRecord,
  hashTree,
  isActionable,
  type ProvenanceRecord,
  readSkillProvenance,
  type SourceRef,
  treeExists,
  writeSkillProvenance,
} from "./install-provenance";

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
  source?: SourceRef,
  discoveryRoot?: string,
): Array<{ name: string; scope: SkillScope; path: string }> {
  mkdirSync(target, { recursive: true });
  const installed: Array<{ name: string; scope: SkillScope; path: string }> = [];
  const now = new Date().toISOString();
  for (const c of candidates) {
    const dest = join(target, sanitizeName(c.name));
    // Read BEFORE the wipe: a re-install of something already tracked should
    // keep its original installedAt rather than look brand new (ADR-0071).
    const previous = readSkillProvenance(dest);
    rmSync(dest, { recursive: true, force: true }); // idempotent re-install
    cpSync(c.dir, dest, { recursive: true });
    if (source) {
      // `skillName` + `sourcePath` together disambiguate a multi-skill repo on
      // the next update: the repo may gain, lose, or RENAME skills, and only
      // the path tells a rename apart from a deletion.
      const sourcePath = discoveryRoot ? relative(discoveryRoot, c.dir) : undefined;
      writeSkillProvenance(
        dest,
        buildRecord(
          { ...source, skillName: c.name, ...(sourcePath ? { sourcePath } : {}) },
          hashTree(dest),
          now,
          previous,
        ),
      );
    }
    installed.push({ name: c.name, scope, path: join(dest, "SKILL.md") });
  }
  return installed;
}

// ── Marketplace support (ADR-0039 phase B) ─────────────────────────────

interface PluginEntry {
  name: string;
  displayName?: string;
  description?: string;
  /** Marketplace catalog category (e.g. "development", "database"). */
  category?: string;
  /** Catalog author — a string or `{ name, email?, url? }`. The provenance
   *  signal ("Anthropic" vs a third party). */
  author?: string | { name?: string };
  source: string | Record<string, unknown>;
}

/** A resolved plugin entry from a marketplace manifest. Exported so the
 *  full-plugin installer (ADR-0053 Phase 3) can reuse marketplace parsing. */
export type { PluginEntry };

/** Read a `.claude-plugin/marketplace.json` if `dir` is a marketplace.
 *  Exported for the full-plugin installer (plugin-installer.ts). */
export function readMarketplace(dir: string): { name: string; plugins: PluginEntry[] } | null {
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

/** Shallow-clone `cloneUrl` (optionally at `ref`) into a fresh temp dir,
 *  tracked in `tmps` for the caller to clean up. Returns null on failure.
 *  Exported for the full-plugin installer (plugin-installer.ts). */
export function cloneInto(cloneUrl: string, ref: string | undefined, tmps: string[]): string | null {
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
 *  sub-repo if needed (tracked in `tmps` for cleanup). Exported for the
 *  full-plugin installer (plugin-installer.ts). */
export function resolvePluginDir(
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
      return {
        ok: true,
        installed: installCandidates(
          chosen,
          target,
          input.scope,
          { url: input.url, plugin: input.plugin },
          resolved.dir,
        ),
      };
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
    return {
      ok: true,
      installed: installCandidates(toInstall, target, input.scope, { url: input.url }, root),
    };
  } finally {
    for (const t of tmps) rmSync(t, { recursive: true, force: true });
  }
}

// ── Updating an installed skill (ADR-0071) ─────────────────────────────

/**
 * Clone whatever `url` points at and return the directory the skill(s) live
 * in. Shares `parseGitUrl` with the install path deliberately — the URL is
 * stored verbatim, so a parser fix applies retroactively to everything
 * already installed.
 */
function cloneParsed(url: string, tmps: string[]): { root?: string; error?: string } {
  const parsed = parseGitUrl(url);
  if (!parsed) return { error: "Not a recognised Git URL." };
  const t = cloneInto(parsed.cloneUrl, parsed.branch, tmps);
  if (!t) return { error: "git clone failed." };
  const root = parsed.subpath ? join(t, parsed.subpath) : t;
  if (!existsSync(root)) {
    return { error: `path '${parsed.subpath}' not found in the repository.` };
  }
  return { root };
}

export interface InstalledSkillRef {
  name: string;
  dir: string;
  scope: SkillScope;
  provenance: ProvenanceRecord | null;
}

/** Every installed skill folder in a scope, with whatever provenance it
 *  carries. Folders installed before ADR-0071 come back with `provenance:
 *  null` — displayable, not updatable, until a URL is supplied once. */
export function listInstalledSkillRefs(
  scope: SkillScope,
  workDir?: string,
): InstalledSkillRef[] {
  const target = targetDir(scope, workDir);
  if (!target || !treeExists(target)) return [];
  const out: InstalledSkillRef[] = [];
  let entries: string[];
  try {
    entries = readdirSync(target);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const dir = join(target, entry);
    const skillMd = join(dir, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    let name = entry;
    try {
      name = parseFrontmatter(readFileSync(skillMd, "utf-8")).name ?? entry;
    } catch {
      /* fall back to the folder name */
    }
    out.push({ name, dir, scope, provenance: readSkillProvenance(dir) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Locate one installed skill by the name the UI shows. Matches the
 *  frontmatter name first, then the folder name — they diverge whenever a
 *  skill's `name:` isn't filesystem-safe. */
function resolveInstalledSkill(
  scope: SkillScope,
  workDir: string | undefined,
  name: string,
): InstalledSkillRef | null {
  const refs = listInstalledSkillRefs(scope, workDir);
  const want = sanitizeName(name);
  return (
    refs.find((r) => r.name === name) ??
    refs.find((r) => sanitizeName(r.name) === want) ??
    refs.find((r) => basename(r.dir) === want) ??
    null
  );
}

export type SkillUpdateStatus = "updated" | "up-to-date" | "update-available" | "error";

export interface SkillUpdateOutcome {
  name: string;
  scope: SkillScope;
  status: SkillUpdateStatus;
  /** Present on `error`. */
  error?: string;
  /** The source it was checked against, when there was one. */
  url?: string;
  /** ISO timestamp after a successful update. */
  lastUpdated?: string;
}

export interface UpdateSkillsResult {
  ok: boolean;
  error?: string;
  results: SkillUpdateOutcome[];
}

/**
 * Re-fetch one installed skill from its recorded source.
 *
 * Skills carry no version field, so "newer?" is decided by comparing a content
 * hash of the upstream folder against the hash recorded at install. That is
 * strictly better than a version string for this case: it also catches an
 * upstream edit that didn't bump anything, and it costs one shallow clone.
 *
 * `url` re-binds provenance — the backfill path for anything installed before
 * ADR-0071, and the escape hatch when a skill moves to a new repo.
 * `checkOnly` stops after the comparison and installs nothing.
 */
export function updateSkill(input: {
  name: string;
  scope: SkillScope;
  workDir?: string;
  url?: string;
  checkOnly?: boolean;
}): SkillUpdateOutcome {
  const { name, scope } = input;
  const fail = (error: string): SkillUpdateOutcome => ({ name, scope, status: "error", error });

  const target = targetDir(scope, input.workDir);
  if (!target) return fail("project-local scope requires a workDir.");

  const ref = resolveInstalledSkill(scope, input.workDir, name);
  if (!ref) return fail(`'${name}' is not installed in ${scope}.`);

  const explicit = input.url?.trim();
  const source: SourceRef | undefined = explicit
    ? { url: explicit, skillName: ref.provenance?.source.skillName ?? ref.name }
    : ref.provenance?.source;

  if (!isActionable(source) || !source?.url) {
    return fail(
      "no recorded source — supply the Git URL once to enable updates for this skill.",
    );
  }

  const tmps: string[] = [];
  try {
    const cloned = cloneParsed(source.url, tmps);
    if (cloned.error || !cloned.root) return fail(cloned.error ?? "clone failed.");

    // A skill acquired through the marketplace flow lives inside a plugin,
    // which may itself be a separate repo — re-resolve it exactly as the
    // install did, or discovery would scan the wrong tree.
    let discoveryRoot = cloned.root;
    if (source.plugin) {
      const mp = readMarketplace(cloned.root);
      if (mp) {
        const entry = mp.plugins.find((p) => p.name === source.plugin);
        if (!entry) return fail(`plugin '${source.plugin}' is no longer in that marketplace.`);
        const resolved = resolvePluginDir(cloned.root, entry, tmps);
        if (resolved.error || !resolved.dir || !existsSync(resolved.dir)) {
          return fail(resolved.error ?? "could not resolve the plugin.");
        }
        discoveryRoot = resolved.dir;
      }
    }

    const candidates = discoverSkills(discoveryRoot);
    if (candidates.length === 0) return fail("no SKILL.md found at that source any more.");

    const wanted = source.skillName ?? ref.name;
    // Path first: it survives an upstream RENAME (same folder, new frontmatter
    // name), which name matching cannot. Name second, for records written
    // before `sourcePath` existed and for a folder that moved but kept its
    // name. The sole-candidate guess is last and deliberately narrow — with a
    // recorded identity, falling back to "the only skill left" would install a
    // DIFFERENT skill over the user's the moment upstream deletes theirs.
    const byPath = source.sourcePath
      ? candidates.find((c) => relative(discoveryRoot, c.dir) === source.sourcePath)
      : undefined;
    const picked =
      byPath ??
      candidates.find((c) => c.name === wanted) ??
      candidates.find((c) => sanitizeName(c.name) === sanitizeName(wanted)) ??
      (!source.skillName && !source.sourcePath && candidates.length === 1
        ? candidates[0]
        : undefined);
    if (!picked) {
      return fail(
        `'${wanted}' is no longer in that repository (found: ${candidates
          .map((c) => c.name)
          .join(", ")}).`,
      );
    }

    const newHash = hashTree(picked.dir);
    // An empty recorded hash means provenance exists but predates hashing (or
    // was hand-written) — treat as unknown and re-install rather than claim
    // it's current.
    const known = ref.provenance?.contentHash;
    if (known && known === newHash) {
      return { name: ref.name, scope, status: "up-to-date", url: source.url };
    }
    if (input.checkOnly) {
      return { name: ref.name, scope, status: "update-available", url: source.url };
    }

    // Upstream may have renamed the skill — install under the new name and
    // remove the old folder so the rename doesn't leave a stale duplicate.
    const dest = join(target, sanitizeName(picked.name));
    const now = new Date().toISOString();
    rmSync(dest, { recursive: true, force: true });
    cpSync(picked.dir, dest, { recursive: true });
    if (dest !== ref.dir) rmSync(ref.dir, { recursive: true, force: true });
    // `newHash` is the hash of the same bytes we just copied, computed with
    // the same exclusions — no need to re-walk the destination.
    const pickedPath = relative(discoveryRoot, picked.dir);
    writeSkillProvenance(
      dest,
      buildRecord(
        { ...source, skillName: picked.name, ...(pickedPath ? { sourcePath: pickedPath } : {}) },
        newHash,
        now,
        ref.provenance,
      ),
    );
    return { name: picked.name, scope, status: "updated", url: source.url, lastUpdated: now };
  } finally {
    for (const t of tmps) rmSync(t, { recursive: true, force: true });
  }
}

/**
 * Update (or check) every installed skill in a scope that has a recorded
 * source. Skills with no provenance are skipped silently rather than reported
 * as errors — "never told us where it came from" is not a failure, and a wall
 * of errors for a pre-ADR-0071 skills tree would bury the real results.
 */
export function updateAllSkills(input: {
  scope: SkillScope;
  workDir?: string;
  checkOnly?: boolean;
}): UpdateSkillsResult {
  const target = targetDir(input.scope, input.workDir);
  if (!target) return { ok: false, error: "project-local scope requires a workDir.", results: [] };

  const results: SkillUpdateOutcome[] = [];
  for (const ref of listInstalledSkillRefs(input.scope, input.workDir)) {
    if (!isActionable(ref.provenance?.source)) continue;
    results.push(
      updateSkill({
        name: ref.name,
        scope: input.scope,
        ...(input.workDir ? { workDir: input.workDir } : {}),
        ...(input.checkOnly ? { checkOnly: true } : {}),
      }),
    );
  }
  return { ok: true, results };
}
