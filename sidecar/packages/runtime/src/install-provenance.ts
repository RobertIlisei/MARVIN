/**
 * Install provenance — remember WHERE a skill or plugin came from (ADR-0071).
 *
 * ADR-0039 (skills) and ADR-0053 (plugins) both install by shallow-cloning a
 * Git repo and copying a directory. Neither recorded the URL, so nothing on
 * disk knew where an installed thing came from — which made "pull the latest
 * version" impossible: there was no source to re-clone. Re-running the install
 * flow worked (both paths `rmSync` the destination first) but only if the user
 * remembered and re-typed the URL, one item at a time.
 *
 * This module is the missing half: a provenance record written at install
 * time, and a content hash so "is there anything new?" can be answered for
 * skills, which carry no version field of their own.
 *
 * Two stores, for one deliberate reason:
 *
 *   - **Skills** get a `.marvin-source.json` INSIDE the installed skill folder.
 *     The folder is the unit of install (and of deletion) — keeping provenance
 *     inside it means removing the skill removes its record, with no registry
 *     to garbage-collect.
 *   - **Plugins** get a sidecar registry in MARVIN's own data dir, NOT a new
 *     field in `~/.claude/plugins/installed_plugins.json`. That file is co-
 *     owned: the Claude Code `/plugin` UI writes it too, and ADR-0053's whole
 *     premise is that an install is visible in both directions. Adding an
 *     unknown key risks the other writer dropping it (silent provenance loss)
 *     — so MARVIN keeps its metadata beside, keyed by the same plugin key.
 *     The cost is that a plugin updated *by Claude Code* leaves our record
 *     stale; the content hash catches that on the next check.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { marvinPaths } from "./paths";

/** Provenance filename written inside an installed skill folder. */
export const SKILL_SOURCE_FILE = ".marvin-source.json";

/**
 * Where an install came from — enough to reproduce it exactly.
 *
 * `url` is stored VERBATIM as the user typed it rather than as the parsed
 * clone URL: `parseGitUrl` already turns a GitHub `tree/<branch>/<path>` web
 * URL into cloneUrl + branch + subpath, and re-parsing the original on update
 * keeps one parser in one place. It also means a fix to the parser applies
 * retroactively to everything already installed.
 */
export interface SourceRef {
  /** The Git URL the user supplied. Absent for the known-marketplace flow. */
  url?: string;
  /** Known-marketplace flow: the marketplace this was installed from. */
  marketplace?: string;
  /** The plugin selected, when the source was a marketplace. */
  plugin?: string;
  /** For a multi-skill repo: which skill was selected out of it. */
  skillName?: string;
  /**
   * Repo-relative folder the skill was taken from (e.g. `skills/pdf`).
   *
   * The name alone cannot survive both of the things upstream does: a skill
   * RENAMED in place and a skill DELETED look identical by name — recorded
   * name absent, some other skill present — and guessing wrong installs the
   * wrong skill over the user's. The path distinguishes them: a rename keeps
   * the folder, a deletion removes it.
   */
  sourcePath?: string;
}

export interface ProvenanceRecord {
  version: 1;
  source: SourceRef;
  installedAt: string;
  lastUpdated: string;
  /** sha256 over the installed tree — see `hashTree`. */
  contentHash: string;
}

/** True when a record carries enough to re-clone from. A record with neither
 *  a URL nor a marketplace is inert (it can be displayed, not acted on). */
export function isActionable(src: SourceRef | undefined): boolean {
  if (!src) return false;
  return Boolean(src.url) || Boolean(src.marketplace && src.plugin);
}

/**
 * Stable content hash of a directory tree.
 *
 * Skills have no version field, so "is the upstream newer?" can only be
 * answered by comparing content. Hashing relative path + bytes (in sorted
 * order) makes the result independent of readdir order and of where the tree
 * happens to be checked out, so a fresh clone and an installed copy of the
 * same content hash identically.
 *
 * Excludes `.git` (clone metadata, never copied) and the provenance file
 * itself (it CONTAINS the hash — including it would be self-referential, and
 * a freshly cloned candidate has no such file anyway).
 */
export function hashTree(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === ".git" || name === SKILL_SOURCE_FILE) continue;
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!st.isFile()) continue;
      h.update(rel);
      h.update("\0");
      try {
        h.update(readFileSync(abs));
      } catch {
        /* unreadable file contributes only its path */
      }
      h.update("\0");
    }
  };
  walk(root, "");
  return `sha256:${h.digest("hex")}`;
}

/** Build a fresh record. `previous` carries `installedAt` forward so an update
 *  doesn't rewrite history as a new install. */
export function buildRecord(
  source: SourceRef,
  contentHash: string,
  now: string,
  previous?: ProvenanceRecord | null,
): ProvenanceRecord {
  return {
    version: 1,
    source,
    installedAt: previous?.installedAt ?? now,
    lastUpdated: now,
    contentHash,
  };
}

// ── Skill provenance (a file inside the skill folder) ──────────────────

function coerceRecord(raw: unknown): ProvenanceRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ProvenanceRecord>;
  if (!r.source || typeof r.source !== "object") return null;
  const s = r.source as SourceRef;
  return {
    version: 1,
    source: {
      ...(typeof s.url === "string" ? { url: s.url } : {}),
      ...(typeof s.marketplace === "string" ? { marketplace: s.marketplace } : {}),
      ...(typeof s.plugin === "string" ? { plugin: s.plugin } : {}),
      ...(typeof s.skillName === "string" ? { skillName: s.skillName } : {}),
      ...(typeof s.sourcePath === "string" ? { sourcePath: s.sourcePath } : {}),
    },
    installedAt: typeof r.installedAt === "string" ? r.installedAt : "",
    lastUpdated: typeof r.lastUpdated === "string" ? r.lastUpdated : "",
    contentHash: typeof r.contentHash === "string" ? r.contentHash : "",
  };
}

/** Read a skill folder's provenance. Never throws — an absent or corrupt
 *  file simply means "no recorded source". */
export function readSkillProvenance(skillDir: string): ProvenanceRecord | null {
  try {
    return coerceRecord(JSON.parse(readFileSync(join(skillDir, SKILL_SOURCE_FILE), "utf-8")));
  } catch {
    return null;
  }
}

/** Write a skill folder's provenance. Best-effort: a failure here must never
 *  fail the install that just succeeded. */
export function writeSkillProvenance(skillDir: string, rec: ProvenanceRecord): void {
  try {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, SKILL_SOURCE_FILE), `${JSON.stringify(rec, null, 2)}\n`, "utf-8");
  } catch {
    /* provenance is an enhancement, not a precondition */
  }
}

/** Provenance for a skill addressed by its `SKILL.md` path (what the skills
 *  index carries). */
export function readSkillProvenanceForSkillMd(skillMdPath: string): ProvenanceRecord | null {
  return readSkillProvenance(dirname(skillMdPath));
}

// ── Plugin provenance (a sidecar registry in MARVIN's data dir) ────────

interface PluginSourcesFile {
  version?: number;
  plugins?: Record<string, ProvenanceRecord>;
}

/** Pure merge — exported so the registry shape can be tested without a HOME.
 *  Preserves every other key untouched. */
export function upsertPluginProvenance(
  file: PluginSourcesFile,
  key: string,
  rec: ProvenanceRecord,
): PluginSourcesFile {
  return {
    version: 1,
    plugins: { ...(file.plugins ?? {}), [key]: rec },
  };
}

function readSourcesFile(): PluginSourcesFile {
  try {
    return JSON.parse(readFileSync(marvinPaths.pluginSources(), "utf-8")) as PluginSourcesFile;
  } catch {
    return { version: 1, plugins: {} };
  }
}

/** Every recorded plugin provenance, keyed by plugin key ("name@marketplace"). */
export function readAllPluginProvenance(): Record<string, ProvenanceRecord> {
  const out: Record<string, ProvenanceRecord> = {};
  for (const [k, v] of Object.entries(readSourcesFile().plugins ?? {})) {
    const rec = coerceRecord(v);
    if (rec) out[k] = rec;
  }
  return out;
}

export function readPluginProvenance(key: string): ProvenanceRecord | null {
  return readAllPluginProvenance()[key] ?? null;
}

/** Best-effort write, same reasoning as the skill side. */
export function writePluginProvenance(key: string, rec: ProvenanceRecord): void {
  try {
    const merged = upsertPluginProvenance(readSourcesFile(), key, rec);
    const p = marvinPaths.pluginSources();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
  } catch {
    /* provenance is an enhancement, not a precondition */
  }
}

/** Drop a plugin's record — used when an install is superseded under a new
 *  key, so the registry doesn't accumulate orphans. */
export function removePluginProvenance(key: string): void {
  try {
    const file = readSourcesFile();
    if (!file.plugins?.[key]) return;
    const plugins = { ...file.plugins };
    delete plugins[key];
    const p = marvinPaths.pluginSources();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`, "utf-8");
  } catch {
    /* non-fatal */
  }
}

/** Public shape the read models expose to the UI — enough to render a row and
 *  decide whether Update is available. */
export interface SourceInfo {
  url?: string;
  marketplace?: string;
  plugin?: string;
  installedAt: string;
  lastUpdated: string;
  /** False when the record can be shown but not acted on (see `isActionable`). */
  updatable: boolean;
}

export function toSourceInfo(rec: ProvenanceRecord | null): SourceInfo | undefined {
  if (!rec) return undefined;
  return {
    ...(rec.source.url ? { url: rec.source.url } : {}),
    ...(rec.source.marketplace ? { marketplace: rec.source.marketplace } : {}),
    ...(rec.source.plugin ? { plugin: rec.source.plugin } : {}),
    installedAt: rec.installedAt,
    lastUpdated: rec.lastUpdated,
    updatable: isActionable(rec.source),
  };
}

/** Exported for the updaters — they need to know whether a tree still exists
 *  before hashing it. */
export function treeExists(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
