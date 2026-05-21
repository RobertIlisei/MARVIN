/**
 * Skills index — assemble the response shape the Skills pane reads.
 *
 * Per ADR-0025, the Skills pane shows three sections + an audit
 * footer. This module produces all of it from a single entry point:
 * fingerprint detection, suggestion-rule application, user-global
 * skill walk, project-local skill walk, audit-decision detection.
 *
 * Shape lines up exactly with the wire contract in ADR-0025
 * (`GET /api/skills`).
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  detectFingerprint,
  type ProjectFingerprint,
} from "@marvin/project-context";

import { readCachedDiscovery } from "./project-skill-discoverer";
import { listProjectSkills } from "./project-skills-plugin";
import {
  applySuggestionRules,
  type SuggestionVerb,
} from "./suggestion-rules";

export interface InstalledSkill {
  name: string;
  description: string;
  path: string;
}

export interface ProjectLocalSkill extends InstalledSkill {
  /** True iff a user-global skill of the same name also exists.
   *  Project-local SHADOWS user-global on conflict (ADR-0024). */
  shadowsUserGlobal: boolean;
}

export interface SkillSuggestion {
  name: string;
  verb: SuggestionVerb;
  matchedTags: string[];
  rationale: string;
  /** True iff the suggested skill already exists in either tree —
   *  the UI suppresses redundant "install" buttons but keeps "build"
   *  buttons available (a project-local rebuild is still legitimate). */
  alreadyInstalled: boolean;
  /** Where the suggestion would land. */
  scope: "user-global" | "project-local";
}

export interface SkillsIndex {
  fingerprint: {
    tags: string[];
    byNamespace: Record<string, string[]>;
    detectedAt: string;
  };
  suggestions: SkillSuggestion[];
  userGlobal: InstalledSkill[];
  projectLocal: ProjectLocalSkill[];
  audit: {
    decided: boolean;
    skillsMdPath: string;
    decisionLine?: string;
  };
  /**
   * Cached LLM-discovered build suggestions (ADR-0028 / development branch).
   * Populated by `bin/marvin knowledge-graph`-style on-demand run via
   * `POST /api/skills/discover`. Empty until the user explicitly clicks
   * "Discover" in the Skills pane.
   */
  discovered: {
    suggestions: Array<{
      name: string;
      description: string;
      rationale: string;
      suggestedBody: string;
    }>;
    discoveredAt: string | null;
    costCents: number | null;
    fingerprintMarker: string | null;
    /** True when the cached suggestions were produced for a fingerprint
     *  that no longer matches — UI shows a "stale, re-run" hint. */
    stale: boolean;
  };
}

const USER_GLOBAL_DIR = join(homedir(), ".claude", "skills");

function listUserGlobalSkills(): InstalledSkill[] {
  const out: InstalledSkill[] = [];
  let entries: string[];
  try {
    const st = statSync(USER_GLOBAL_DIR);
    if (!st.isDirectory()) return out;
    entries = readdirSync(USER_GLOBAL_DIR);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const skillMd = join(USER_GLOBAL_DIR, name, "SKILL.md");
    try {
      const text = readFileSync(skillMd, "utf-8");
      const fm = parseFrontmatter(text);
      out.push({
        name: fm.name ?? name,
        description: fm.description ?? "",
        path: skillMd,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Tiny YAML-frontmatter parser. Same shape as the one in
 * `project-skills-plugin.ts`; duplicated rather than re-exported
 * because the parser is a 20-line implementation and a re-export
 * cycle isn't worth the savings.
 */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end < 0) return {};
  const block = text.slice(4, end);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const valRaw = m[2] ?? "";
    const val = valRaw.trim().replace(/^['"](.*)['"]$/, "$1");
    if (key === "name" || key === "description") {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Assemble the full skills-index response. Cheap on every call —
 * one fingerprint pass, one walk per skill tree, one rules
 * application. Safe to call on every Skills-pane refresh.
 */
export function buildSkillsIndex(workDir: string): SkillsIndex {
  const fp: ProjectFingerprint = detectFingerprint(workDir);

  const userGlobal = listUserGlobalSkills();
  const userGlobalNames = new Set(userGlobal.map((s) => s.name));

  const projectLocalRaw = listProjectSkills(workDir);
  const projectLocal: ProjectLocalSkill[] = projectLocalRaw
    .map((s) => ({
      ...s,
      shadowsUserGlobal: userGlobalNames.has(s.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const projectLocalNames = new Set(projectLocal.map((s) => s.name));

  const suggestions: SkillSuggestion[] = applySuggestionRules(fp.tags).map(
    ({ rule, matchedTags }) => {
      const inUserGlobal = userGlobalNames.has(rule.suggest);
      const inProjectLocal = projectLocalNames.has(rule.suggest);
      return {
        name: rule.suggest,
        verb: rule.verb,
        matchedTags,
        rationale: rule.rationale,
        alreadyInstalled:
          rule.verb === "install" ? inUserGlobal : inProjectLocal,
        scope: rule.verb === "install" ? "user-global" : "project-local",
      };
    },
  );

  const skillsMdPath = join(workDir, ".marvin", "skills.md");
  let decisionLine: string | undefined;
  let decided = false;
  try {
    const text = readFileSync(skillsMdPath, "utf-8").trim();
    if (text) {
      decided = true;
      decisionLine = text.split("\n")[0]?.slice(0, 200);
    }
  } catch {
    /* not present → not decided */
  }

  // Read cached LLM-discovered build suggestions (if any). The cache
  // file is written by `POST /api/skills/discover`; this read is best-
  // effort — corrupt or absent → empty suggestions, never throws.
  const cachedDiscovery = readCachedDiscovery(workDir);
  const currentFingerprintMarker = fp.tags.join("|");
  const discovered = {
    suggestions: cachedDiscovery?.suggestions ?? [],
    discoveredAt: cachedDiscovery?.discoveredAt ?? null,
    costCents: cachedDiscovery?.costCents ?? null,
    fingerprintMarker: cachedDiscovery?.fingerprintMarker ?? null,
    stale:
      cachedDiscovery != null &&
      cachedDiscovery.fingerprintMarker !== currentFingerprintMarker,
  };

  return {
    fingerprint: {
      tags: fp.tags,
      byNamespace: fp.byNamespace,
      detectedAt: fp.detectedAt,
    },
    suggestions,
    userGlobal,
    projectLocal,
    audit: {
      decided,
      skillsMdPath,
      ...(decisionLine ? { decisionLine } : {}),
    },
    discovered,
  };
}

/**
 * Write the audit-decision file. Idempotent when called twice with
 * the same `note` — overwrites the existing file. The audit-pending
 * firm-surface block in `personality.ts` checks for the file's
 * existence + non-empty content, so writing any non-empty body is
 * enough to flip the decision to "made".
 *
 * Caller is responsible for the CSRF check; this module is pure FS.
 */
export function writeSkillsAuditDecision(
  workDir: string,
  opts: { note?: string; parkedNames?: string[] } = {},
): { skillsMdPath: string; line: string } {
  const skillsMdPath = join(workDir, ".marvin", "skills.md");
  mkdirSync(join(workDir, ".marvin"), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const noteSuffix = opts.note ? ` — ${opts.note}` : "";
  const parkedSuffix =
    opts.parkedNames && opts.parkedNames.length > 0
      ? ` (parked: ${opts.parkedNames.join(", ")})`
      : "";
  const line = `audited ${date}${parkedSuffix}${noteSuffix}`;
  writeFileSync(skillsMdPath, line + "\n", { encoding: "utf-8" });
  return { skillsMdPath, line };
}

/**
 * Remove the audit-decision file. Re-arms the audit-pending block
 * starting next session.
 */
export function clearSkillsAuditDecision(workDir: string): { removed: boolean } {
  const skillsMdPath = join(workDir, ".marvin", "skills.md");
  if (!existsSync(skillsMdPath)) return { removed: false };
  try {
    unlinkSync(skillsMdPath);
    return { removed: true };
  } catch {
    return { removed: false };
  }
}
