/**
 * Skill enablement (ADR-0037) — the "installed vs active" layer.
 *
 * The SDK's `claude_code` preset loads EVERY user-global skill from
 * `~/.claude/skills/` into every session, for every project — there is no
 * main-thread skills allowlist in the SDK (0.2.113 exposes one only on
 * `AgentDefinition`, and `settingSources` doesn't scope skills). So a
 * Swift app still carries `xlsx`, `pptx`, `canvas-design`, etc. — 20 skills
 * where 4 are relevant. That's the "MARVIN discovers a lot we don't need"
 * problem: they're not discovered, they're just always loaded.
 *
 * We can't stop the SDK loading them, but we CAN tell the model which
 * skills are ACTIVE for this project and to ignore the rest — the same
 * firm-surface / prompt-enforced pattern MARVIN uses for Ask mode. The
 * active set:
 *
 *   - defaults from the fingerprint: a small always-on engineering core +
 *     the install-suggestions whose tags matched this project's stack;
 *   - is user-overridable via `<workDir>/.marvin/skills.json` (the Skills
 *     pane writes it);
 *   - always includes project-local skills (authored FOR this project).
 *
 * The recommendation engine (suggestion-rules) was already well-curated;
 * this is the missing enablement layer, not a new discovery mechanism.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildSkillsIndex, type SkillsIndex } from "./skills-index";

/**
 * Always-on engineering-process skills — applicable to essentially any
 * codebase, so they're active regardless of fingerprint. Everything else
 * in the bundle is "domain" (document / design / format / framework
 * capabilities) and is gated on a fingerprint match via suggestion-rules.
 */
export const CORE_SKILLS: ReadonlySet<string> = new Set([
  "graphify",
  "skill-creator",
  "systematic-debugging",
  "test-driven-development",
  "pr-review",
  "security-audit",
]);

interface SkillsJson {
  /** User-chosen active skill names. Present iff the user has overridden
   *  the fingerprint default via the Skills pane. */
  enabled?: string[];
  source?: "auto" | "user";
  decidedAt?: string;
}

function skillsJsonPath(workDir: string): string {
  return join(workDir, ".marvin", "skills.json");
}

/** The user's explicit enabled set, or null when they haven't chosen one
 *  (so callers fall back to the fingerprint default). */
export function readEnabledSkills(workDir: string): string[] | null {
  try {
    const j = JSON.parse(readFileSync(skillsJsonPath(workDir), "utf-8")) as SkillsJson;
    if (Array.isArray(j.enabled)) {
      return j.enabled.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* absent / corrupt → no explicit choice */
  }
  return null;
}

/** Persist the user's active set (Skills-pane toggle). CSRF is the
 *  caller's job; this is pure FS. */
export function setEnabledSkills(workDir: string, enabled: string[]): void {
  mkdirSync(join(workDir, ".marvin"), { recursive: true });
  const payload: SkillsJson = {
    enabled: [...new Set(enabled)].sort(),
    source: "user",
    decidedAt: new Date().toISOString(),
  };
  writeFileSync(skillsJsonPath(workDir), JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

export interface ActiveSkills {
  /** The active skill names for this project. */
  active: string[];
  /** True iff the active set came from an explicit user choice (skills.json)
   *  rather than the fingerprint default. */
  explicit: boolean;
  /** The full skills index used to compute it (so callers don't re-walk). */
  index: SkillsIndex;
}

/**
 * Compute the active skill set for a project. Explicit user choice
 * (skills.json) wins; otherwise the fingerprint default = core ∪
 * fingerprint-suggested-installs. Project-local skills are ALWAYS active —
 * they were authored for this project. Only ever returns skills that are
 * actually installed.
 */
/**
 * Pure active-set selection — the testable core of {@link computeActiveSkills}.
 * Explicit user choice wins (intersected with installed); otherwise the
 * fingerprint default = core ∪ matched install-suggestions. Project-local
 * skills are always active. Only returns installed skills.
 */
export function selectActiveSkills(
  index: Pick<SkillsIndex, "userGlobal" | "projectLocal" | "suggestions">,
  explicit: string[] | null,
): string[] {
  const installed = new Set(index.userGlobal.map((s) => s.name));
  const set = new Set<string>();
  if (explicit) {
    for (const n of explicit) if (installed.has(n)) set.add(n);
  } else {
    for (const n of installed) if (CORE_SKILLS.has(n)) set.add(n);
    for (const s of index.suggestions) {
      if (s.verb === "install" && installed.has(s.name)) set.add(s.name);
    }
  }
  for (const s of index.projectLocal) set.add(s.name); // always active
  return [...set].sort();
}

export function computeActiveSkills(workDir: string): ActiveSkills {
  const index = buildSkillsIndex(workDir);
  const explicit = readEnabledSkills(workDir);
  return { active: selectActiveSkills(index, explicit), explicit: explicit != null, index };
}

/**
 * The per-session system-prompt block naming the active skills and telling
 * the model NOT to reach for the inactive ones. Empty when no skills are
 * installed. This is the actual lever — the SDK still loads everything, but
 * the model is told what's relevant here.
 */
export function formatActiveSkillsBlock(workDir: string): string {
  let res: ActiveSkills;
  try {
    res = computeActiveSkills(workDir);
  } catch {
    return "";
  }
  const { active, index } = res;
  const all = [...index.userGlobal, ...index.projectLocal];
  if (all.length === 0) return "";

  const activeSet = new Set(active);
  const activeLines = all
    .filter((s) => activeSet.has(s.name))
    .map((s) => `- \`${s.name}\` — ${s.description || "(no description)"}`)
    .join("\n");
  const inactive = index.userGlobal.filter((s) => !activeSet.has(s.name)).map((s) => s.name);

  const lines = [
    "## Active skills for this project",
    "",
    "Of the skills installed on this machine, these are the ones relevant " +
      "to THIS project — reach for them per their own triggers:",
    "",
    activeLines || "- (none active)",
  ];
  if (inactive.length > 0) {
    lines.push(
      "",
      `The other installed skills — ${inactive.join(", ")} — are NOT relevant ` +
        "to this project. Do not invoke them. If you genuinely need one, say " +
        "so and tell the user to enable it in the Skills pane (it records the " +
        "choice in `.marvin/skills.json`); do not reach for it unprompted.",
    );
  }
  return lines.join("\n");
}
