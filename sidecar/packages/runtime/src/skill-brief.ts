/**
 * The skills a brief names, recorded by the sidecar (ADR-0138).
 *
 * Measured on one real project: 95 tabs named skills in their brief and
 * closed scope-met; 3 invoked every skill they named. The two skills the
 * ship-review gate enforces were run 60 % and 22 % of the time that gate
 * covered them; everything asked for in prose alone sat between 0 % and 25 %.
 *
 * Same shape as the seeded plan (ADR-0124 D): when the first user message
 * carries a `Skills:` line, MARVIN records the list on the session meta before
 * the model's first tool call, no prompt text involved. The Stop hook reads it
 * at a scope-met close (`decideSkillClose`, turn-close-hook.ts). MARVIN ships
 * no skill names: the list is whatever the brief says.
 */

import { readSlashCommands, buildFilesystemCatalog } from "./slash-commands";
import { marvinPaths } from "./paths";
import { scanSessionSummary } from "./session";
import { readSessionMeta, updateSessionMeta } from "./session-meta";

/** Names kept per brief, and per session's run list. */
export const SKILLS_MAX = 20;
const SKILLS_RUN_MAX = 64;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/** `ponytail:ponytail` → `ponytail`: plugin skills arrive namespaced, a brief
 *  names the bare skill. Compared on the last `:` segment, case-insensitively. */
export function normaliseSkillName(raw: string): string {
  const s = raw.trim().replace(/^\//, "");
  return (s.split(":").pop() ?? s).trim().toLowerCase();
}

/** The backticked names in a fragment, after dropping parenthesised notes
 *  (`(full)`, `(audit only)`, a note that itself holds backticks). */
function backtickedNames(fragment: string): string[] {
  const out: string[] = [];
  const text = fragment.replace(/\([^)]*\)/g, " ");
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const raw = (m[1] ?? "").trim();
    if (!NAME.test(raw)) continue;
    out.push(normaliseSkillName(raw));
  }
  return out;
}

const LABEL = /^\s*(?:[-*>]\s+)?(?:\*\*)?skills(?:\*\*)?\s*:(?:\*\*)?\s*(.*)$/i;
const HEADING = /^\s{0,3}#{1,6}\s*skills\s*:?\s*$/i;
const NEXT_HEADING = /^\s{0,3}#{1,6}\s/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/**
 * The skill names a brief carries, or null. Three shapes: a `Skills:` line, a
 * bold `**Skills:**` label, and a `## Skills` heading followed by a list.
 * Names must be in backticks (prose such as "Skills: whatever is needed" names
 * nothing). Bounded, deduplicated, normalised. Pure.
 */
export function parseSkillsLine(message: string): string[] | null {
  const names: string[] = [];
  const lines = message.split("\n");
  let inList = false;
  for (const line of lines) {
    if (inList) {
      if (NEXT_HEADING.test(line)) {
        inList = false;
      } else {
        const item = LIST_ITEM.exec(line);
        if (item) {
          names.push(...backtickedNames(item[1] ?? ""));
          continue;
        }
        if (line.trim() === "") continue;
        inList = false; // prose ends the list
      }
    }
    if (HEADING.test(line)) {
      inList = true;
      continue;
    }
    const label = LABEL.exec(line);
    if (label) names.push(...backtickedNames(label[1] ?? ""));
  }
  const unique = [...new Set(names)].slice(0, SKILLS_MAX);
  return unique.length > 0 ? unique : null;
}

const WAIVER = /^\s*(?:[-*>]\s+)?(?:\*\*)?Skill not used(?:\*\*)?\s*:(?:\*\*)?\s*`?([A-Za-z0-9][A-Za-z0-9._:-]*)`?\s*(?:—|–|--?|:)\s*(\S.{2,})$/gim;

/** `Skill not used: <name> — <reason>` lines of a final message, by normalised name. */
export function parseSkillWaivers(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(WAIVER)) {
    const name = normaliseSkillName(m[1] ?? "");
    if (name && !out.has(name)) out.set(name, (m[2] ?? "").trim());
  }
  return out;
}

export interface SeedSkillsResult {
  seeded: boolean;
  reason: string;
  names?: string[];
}

/** Is this the session's first user message? The transcript already holds the
 *  current turn's `turn.user` line when the runner starts, so first means one. */
function isFirstUserTurn(projectId: string, sessionId: string): boolean {
  try {
    return scanSessionSummary(marvinPaths.sessionFile(projectId, sessionId)).turnCount === 1;
  } catch {
    return false;
  }
}

/**
 * The runner's entry point, next to `seedTurnSpine`: when the session's FIRST
 * message carries a skills list, record it on the session meta. Seeds once; a
 * wakeup is never a brief. Never throws.
 */
export function seedTurnSkills(args: {
  projectId: string;
  sessionId: string;
  message: string;
  turnId: string;
  isFirstTurn?: () => boolean;
}): SeedSkillsResult {
  if (/^\[(scheduled wakeup|queued |\d+ messages queued|Message from the MARVIN supervisor)/.test(args.message)) {
    return { seeded: false, reason: "machine message" };
  }
  try {
    const names = parseSkillsLine(args.message);
    if (!names) return { seeded: false, reason: "no skills line" };
    const meta = readSessionMeta(args.projectId, args.sessionId);
    if (!meta) return { seeded: false, reason: "no session meta" };
    if (meta.skills) return { seeded: false, reason: "already seeded" };
    const first = args.isFirstTurn ? args.isFirstTurn() : isFirstUserTurn(args.projectId, args.sessionId);
    if (!first) return { seeded: false, reason: "not the first message" };
    const seededAt = new Date().toISOString();
    if (!updateSessionMeta(args.projectId, args.sessionId, { skills: { required: names, seededAt } })) {
      return { seeded: false, reason: "meta write failed" };
    }
    console.info(
      "[marvin.telemetry] " + JSON.stringify({ kind: "skills.seed", turnId: args.turnId, count: names.length, at: seededAt }),
    );
    return { seeded: true, reason: "seeded", names };
  } catch {
    return { seeded: false, reason: "error" };
  }
}

/** Remember that this session ran a skill. Idempotent; never throws. */
export function noteSkillRun(projectId: string, sessionId: string, rawName: string): void {
  try {
    const name = normaliseSkillName(rawName);
    if (!name) return;
    const meta = readSessionMeta(projectId, sessionId);
    if (!meta) return;
    const run = meta.skillsRun ?? [];
    if (run.includes(name)) return;
    updateSessionMeta(projectId, sessionId, { skillsRun: [...run, name].slice(-SKILLS_RUN_MAX) });
  } catch {
    /* recording must never break a tool call */
  }
}

/** The skills a session has run, by normalised name. */
export function skillsRunOf(projectId: string, sessionId: string): string[] {
  return readSessionMeta(projectId, sessionId)?.skillsRun ?? [];
}

/**
 * Of `names`, the ones this project cannot invoke at all. Judged against the
 * SDK's captured catalog plus the skills on disk; with no captured catalog
 * availability is unknown and nothing is reported (a missed report only costs
 * a block that the waiver line discharges).
 */
function unavailableSkills(projectId: string, workDir: string, names: string[]): string[] {
  try {
    const captured = readSlashCommands(projectId);
    if (!captured) return [];
    const known = new Set<string>();
    for (const c of [...captured.commands, ...buildFilesystemCatalog(workDir)]) known.add(normaliseSkillName(c.name));
    return names.filter((n) => !known.has(n));
  } catch {
    return [];
  }
}

export interface SkillCloseFacts {
  required: string[];
  used: string[];
  unavailable: string[];
  /** Scope-met closes already refused for these skills. */
  blocks: number;
}

/** What the Stop hook needs, or null when the session has no seeded list. */
export function skillCloseFacts(projectId: string, sessionId: string, workDir: string): SkillCloseFacts | null {
  const meta = readSessionMeta(projectId, sessionId);
  const required = meta?.skills?.required;
  if (!meta || !required || required.length === 0) return null;
  const run = new Set(meta.skillsRun ?? []);
  const used = required.filter((n) => run.has(n));
  const missing = required.filter((n) => !run.has(n));
  return { required, used, unavailable: unavailableSkills(projectId, workDir, missing), blocks: meta.skills?.blocks ?? 0 };
}

/** Count one refused close on the session meta (the two-block brake). */
export function noteSkillBlock(projectId: string, sessionId: string): void {
  try {
    const meta = readSessionMeta(projectId, sessionId);
    if (!meta?.skills) return;
    updateSessionMeta(projectId, sessionId, { skills: { ...meta.skills, blocks: (meta.skills.blocks ?? 0) + 1 } });
  } catch {
    /* the brake is best-effort */
  }
}
