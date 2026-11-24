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

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { marvinPaths } from "./paths";
import { scanSessionSummary } from "./session";
import { readSessionMeta, updateSessionMeta } from "./session-meta";
import { buildFilesystemCatalog, readSlashCommands } from "./slash-commands";

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

/** A skill named in a brief, and whether its parenthesised note says `first`. */
interface NamedSkill {
  name: string;
  first: boolean;
}

/** The note marks a start skill when it holds the word `first` (`(first)`,
 *  `(full, first)`, `(first, full)`); `firstly` and `firsthand` do not. */
const FIRST_WORD = /\bfirst\b/i;

/**
 * The backticked names in a fragment, each with whether the parenthesised note
 * that directly follows it says `first`. A note is consumed whole, so a note
 * that itself holds backticks (`(see `x` first)`) names nothing and still
 * marks the skill it follows.
 */
function namedSkills(fragment: string): NamedSkill[] {
  const out: NamedSkill[] = [];
  let lastEnd = -1;
  for (const m of fragment.matchAll(/`([^`\n]+)`|\(([^)]*)\)/g)) {
    const at = m.index ?? 0;
    if (m[1] !== undefined) {
      const raw = m[1].trim();
      if (!NAME.test(raw)) continue;
      out.push({ name: normaliseSkillName(raw), first: false });
      lastEnd = at + m[0].length;
      continue;
    }
    const last = out[out.length - 1];
    if (last && lastEnd >= 0 && fragment.slice(lastEnd, at).trim() === "" && FIRST_WORD.test(m[2] ?? "")) {
      last.first = true;
    }
    lastEnd = -1;
  }
  return out;
}

const LABEL = /^\s*(?:[-*>]\s+)?(?:\*\*)?skills(?:\*\*)?\s*:(?:\*\*)?\s*(.*)$/i;
/** `Skills first: …` / `**Skills first:** …`: every name on the line is a start skill. */
const FIRST_LABEL = /^\s*(?:[-*>]\s+)?(?:\*\*)?skills\s+first(?:\*\*)?\s*:(?:\*\*)?\s*(.*)$/i;
const HEADING = /^\s{0,3}#{1,6}\s*skills\s*:?\s*$/i;
const NEXT_HEADING = /^\s{0,3}#{1,6}\s/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

export interface SkillsBrief {
  /** Every skill the brief names, in order. */
  required: string[];
  /** The ones the brief marks as start skills (a subset of `required`). */
  first: string[];
}

/**
 * The skills a brief carries, or null. Three shapes: a `Skills:` line, a bold
 * `**Skills:**` label, and a `## Skills` heading followed by a list; plus the
 * `first` marker, in a note after a name or on a `Skills first:` line (whose
 * names also count as named). Names must be in backticks (prose such as
 * "Skills: whatever is needed" names nothing). Bounded, deduplicated,
 * normalised. Pure.
 */
export function parseSkillsBrief(message: string): SkillsBrief | null {
  const found: NamedSkill[] = [];
  const lines = message.split("\n");
  let inList = false;
  for (const line of lines) {
    if (inList) {
      if (NEXT_HEADING.test(line)) {
        inList = false;
      } else {
        const item = LIST_ITEM.exec(line);
        if (item) {
          found.push(...namedSkills(item[1] ?? ""));
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
    const firstLabel = FIRST_LABEL.exec(line);
    if (firstLabel) {
      found.push(...namedSkills(firstLabel[1] ?? "").map((n) => ({ ...n, first: true })));
      continue;
    }
    const label = LABEL.exec(line);
    if (label) found.push(...namedSkills(label[1] ?? ""));
  }
  const required = [...new Set(found.map((n) => n.name))].slice(0, SKILLS_MAX);
  if (required.length === 0) return null;
  const first = required.filter((name) => found.some((n) => n.name === name && n.first));
  return { required, first };
}

/** The skill names a brief carries, or null (ADR-0138). */
export function parseSkillsLine(message: string): string[] | null {
  return parseSkillsBrief(message)?.required ?? null;
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
  /** The project root: where `.marvin/skills.json` (`first`) is read. */
  workDir?: string;
}): SeedSkillsResult {
  if (/^\[(scheduled wakeup|queued |\d+ messages queued|Message from the MARVIN supervisor)/.test(args.message)) {
    return { seeded: false, reason: "machine message" };
  }
  try {
    const brief = parseSkillsBrief(args.message);
    if (!brief) return { seeded: false, reason: "no skills line" };
    const names = brief.required;
    const meta = readSessionMeta(args.projectId, args.sessionId);
    if (!meta) return { seeded: false, reason: "no session meta" };
    if (meta.skills) return { seeded: false, reason: "already seeded" };
    const first = args.isFirstTurn ? args.isFirstTurn() : isFirstUserTurn(args.projectId, args.sessionId);
    if (!first) return { seeded: false, reason: "not the first message" };
    // A start skill is one the brief marks `first`, or one the project's own
    // setting says belongs at the start AND the brief names. The setting never
    // adds a skill the brief did not ask for. Resolved here, once: a session
    // already running keeps the list it was seeded with.
    const projectFirst = new Set(args.workDir ? readProjectFirstSkills(args.workDir) : []);
    const startSkills = names.filter((n) => brief.first.includes(n) || projectFirst.has(n));
    const seededAt = new Date().toISOString();
    if (!updateSessionMeta(args.projectId, args.sessionId, { skills: { required: names, first: startSkills, seededAt } })) {
      return { seeded: false, reason: "meta write failed" };
    }
    console.info(
      "[marvin.telemetry] " + JSON.stringify({ kind: "skills.seed", turnId: args.turnId, count: names.length, first: startSkills.length, at: seededAt }),
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
export function unavailableSkills(projectId: string, workDir: string, names: string[]): string[] {
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

/** Start skills a project may declare in `.marvin/skills.json`, at most. */
const FIRST_SETTING_MAX = 20;

/**
 * The project's own list of skills that belong at the start of a session
 * (`first` in `<workDir>/.marvin/skills.json`, next to the Skills pane's
 * `enabled`). A file inside the user's repository is written by whoever wrote
 * the repository, so this reads at a validating boundary: an array of at most
 * 20 strings, each a valid skill name, normalised and deduplicated; anything
 * else reads as no setting. It only says "this one belongs at the start": a
 * session gets it when its brief names the skill.
 */
export function readProjectFirstSkills(workDir: string): string[] {
  try {
    const j = JSON.parse(readFileSync(join(workDir, ".marvin", "skills.json"), "utf-8")) as { first?: unknown } | null;
    if (!j || !Array.isArray(j.first)) return [];
    const out: string[] = [];
    for (const raw of j.first) {
      if (typeof raw !== "string" || !NAME.test(raw.trim())) continue;
      const name = normaliseSkillName(raw);
      if (name && !out.includes(name)) out.push(name);
      if (out.length >= FIRST_SETTING_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

export interface SkillsFirstFacts {
  /** Start skills that have not run and that this project can invoke. */
  missing: string[];
  /** Mutations already refused for these skills, across turns and restarts. */
  blocks: number;
}

/**
 * What the skills-first gate needs, or null when there is nothing to gate: no
 * seeded list, no start skill (a session seeded before `first` existed has
 * none), every start skill already run, or none of the missing ones can be
 * invoked here (reported unavailable, like the close gate).
 */
export function skillsFirstFacts(projectId: string, sessionId: string, workDir: string): SkillsFirstFacts | null {
  const meta = readSessionMeta(projectId, sessionId);
  const first = meta?.skills?.first;
  if (!meta?.skills || !first || first.length === 0) return null;
  const run = new Set(meta.skillsRun ?? []);
  const notRun = first.filter((n) => !run.has(n));
  if (notRun.length === 0) return null;
  const gone = new Set(unavailableSkills(projectId, workDir, notRun));
  const missing = notRun.filter((n) => !gone.has(n));
  if (missing.length === 0) return null;
  return { missing, blocks: meta.skills.firstBlocks ?? 0 };
}

/** Count one refused mutation on the session meta (the two-refusal brake). */
export function noteSkillFirstBlock(projectId: string, sessionId: string): void {
  try {
    const meta = readSessionMeta(projectId, sessionId);
    if (!meta?.skills) return;
    updateSessionMeta(projectId, sessionId, { skills: { ...meta.skills, firstBlocks: (meta.skills.firstBlocks ?? 0) + 1 } });
  } catch {
    /* the brake is best-effort */
  }
}

/**
 * The one line the turn's `<system-reminder>` suffix carries while seeded
 * skills have not run, or null when none is missing. A skill this project
 * cannot invoke is left out (asking for it would only stall). Per-turn text:
 * it rides the reminder, never the system prompt append (AGENTS.md, Agent SDK
 * contract). Never throws.
 */
export function skillsReminder(projectId: string, sessionId: string, workDir: string): string | null {
  try {
    const meta = readSessionMeta(projectId, sessionId);
    const required = meta?.skills?.required;
    if (!meta || !required || required.length === 0) return null;
    const run = new Set(meta.skillsRun ?? []);
    const notRun = required.filter((n) => !run.has(n));
    if (notRun.length === 0) return null;
    const gone = new Set(unavailableSkills(projectId, workDir, notRun));
    const missing = notRun.filter((n) => !gone.has(n));
    if (missing.length === 0) return null;
    const list = (names: string[]) => names.map((n) => `\`${n}\``).join(", ");
    const startMissing = missing.filter((n) => (meta.skills?.first ?? []).includes(n));
    return (
      `Skills this brief named and not yet used: ${list(missing)}.` +
      (startMissing.length > 0 ? ` Run now, before your first change: ${list(startMissing)}.` : "")
    );
  } catch {
    return null;
  }
}
